"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { dbErrorText, needsSchemaSetup } from "@/lib/dbError";
import {
  BUDGET_SECTION_LABEL,
  BUDGET_SECTIONS,
  BudgetLine,
  BudgetSection,
  budgetForecast,
  ConstructionObject,
  CustomerPayment,
  HistoryEntry,
} from "@/lib/types";
import { fmtDate, fmtDateTime, fmtMoney, plural } from "@/lib/format";
import { OBJECT_KEY, readSetting, writeSetting } from "@/lib/useClient";
import SchemaSetup from "@/components/SchemaSetup";

/** Выбранный объект — общий для всех вкладок: выбрали на одной, открыт и на остальных. */
const LS_OBJECT_KEY = OBJECT_KEY;

type Basis = "plan" | "fact" | "forecast";
type SectionFilter = BudgetSection | "all";

const SECTION_VAR: Record<BudgetSection, string> = {
  materials: "var(--sect-materials)",
  works: "var(--sect-works)",
  equipment: "var(--sect-equipment)",
};

/* ============================== Статьи бюджета ============================== */

interface LineForm {
  section: BudgetSection;
  name: string;
  planAmount: string;
  factAmount: string;
  forecastAmount: string;
  note: string;
}

const EMPTY_LINE_FORM: LineForm = {
  section: "materials",
  name: "",
  planAmount: "",
  factAmount: "",
  forecastAmount: "",
  note: "",
};

function lineToForm(l: BudgetLine | null): LineForm {
  if (!l) return { ...EMPTY_LINE_FORM };
  return {
    section: l.section,
    name: l.name,
    planAmount: String(l.plan_amount ?? 0),
    factAmount: String(l.fact_amount ?? 0),
    forecastAmount: l.forecast_amount != null ? String(l.forecast_amount) : "",
    note: l.note || "",
  };
}

/* ============================== Взаиморасчёты ============================== */

interface PaymentForm {
  paymentDate: string;
  amount: string;
  document: string;
  note: string;
}

const EMPTY_PAYMENT_FORM: PaymentForm = { paymentDate: "", amount: "", document: "", note: "" };

function paymentToForm(p: CustomerPayment | null): PaymentForm {
  if (!p) return { ...EMPTY_PAYMENT_FORM };
  return {
    paymentDate: p.payment_date,
    amount: String(p.amount ?? 0),
    document: p.document || "",
    note: p.note || "",
  };
}

export default function BudgetModule() {
  const [objects, setObjects] = useState<ConstructionObject[]>([]);
  const [objectId, setObjectId] = useState<string>("");
  const [loadingObjects, setLoadingObjects] = useState(true);
  const [loadingData, setLoadingData] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [schemaMissing, setSchemaMissing] = useState(false);

  const [lines, setLines] = useState<BudgetLine[]>([]);
  const [payments, setPayments] = useState<CustomerPayment[]>([]);
  const [signedActsSum, setSignedActsSum] = useState(0);
  const [orderedSupplySum, setOrderedSupplySum] = useState(0);

  const [basis, setBasis] = useState<Basis>("plan");
  const [sectionFilter, setSectionFilter] = useState<SectionFilter>("all");

  const [linePanelOpen, setLinePanelOpen] = useState(false);
  const [editingLineId, setEditingLineId] = useState<string | null>(null);
  const [lineForm, setLineForm] = useState<LineForm>(EMPTY_LINE_FORM);
  const [lineSaving, setLineSaving] = useState(false);
  const [lineDetailId, setLineDetailId] = useState<string | null>(null);
  const [linePendingDeleteId, setLinePendingDeleteId] = useState<string | null>(null);

  const [paymentPanelOpen, setPaymentPanelOpen] = useState(false);
  const [editingPaymentId, setEditingPaymentId] = useState<string | null>(null);
  const [paymentForm, setPaymentForm] = useState<PaymentForm>(EMPTY_PAYMENT_FORM);
  const [paymentSaving, setPaymentSaving] = useState(false);
  const [paymentDetailId, setPaymentDetailId] = useState<string | null>(null);
  const [paymentPendingDeleteId, setPaymentPendingDeleteId] = useState<string | null>(null);

  const loadObjects = useCallback(async () => {
    setLoadingObjects(true);
    const { data, error } = await supabase
      .from("objects")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) {
      setBanner(dbErrorText(error, "Не удалось загрузить объекты"));
      setLoadingObjects(false);
      return;
    }
    const list = (data as ConstructionObject[]) || [];
    setObjects(list);
    const saved = readSetting(LS_OBJECT_KEY) || "";
    setObjectId(list.find((o) => o.id === saved)?.id || list[0]?.id || "");
    setLoadingObjects(false);
  }, []);

  // При быстром переключении объектов запоздавший ответ по прежнему объекту отбрасывается.
  const objectIdRef = useRef(objectId);
  useEffect(() => {
    objectIdRef.current = objectId;
  }, [objectId]);

  const loadObjectData = useCallback(async (id: string) => {
    if (!id) {
      setLines([]);
      setPayments([]);
      setSignedActsSum(0);
      setOrderedSupplySum(0);
      return;
    }
    setLoadingData(true);
    const [lineRes, payRes, actRes, supplyRes] = await Promise.all([
      supabase.from("budget_lines").select("*").eq("object_id", id).order("created_at"),
      supabase.from("customer_payments").select("*").eq("object_id", id).order("payment_date", { ascending: false }),
      supabase.from("acceptance_acts").select("amount").eq("object_id", id).eq("status", "signed"),
      supabase.from("supply_requests").select("order_amount,status").eq("object_id", id).in("status", ["ordered", "delivered"]),
    ]);
    if (id !== objectIdRef.current) return;
    const missing = needsSchemaSetup(lineRes.error) || needsSchemaSetup(payRes.error);
    setSchemaMissing(missing);
    if (lineRes.error) setBanner(dbErrorText(lineRes.error, "Не удалось загрузить статьи бюджета"));
    else if (payRes.error && !needsSchemaSetup(payRes.error)) setBanner(dbErrorText(payRes.error, "Не удалось загрузить платежи"));

    setLines((lineRes.data as BudgetLine[]) || []);
    setPayments((payRes.data as CustomerPayment[]) || []);
    setSignedActsSum(
      needsSchemaSetup(actRes.error)
        ? 0
        : ((actRes.data as { amount: number | null }[]) || []).reduce((s, a) => s + (a.amount || 0), 0)
    );
    setOrderedSupplySum(
      needsSchemaSetup(supplyRes.error)
        ? 0
        : ((supplyRes.data as { order_amount: number | null }[]) || []).reduce((s, r) => s + (r.order_amount || 0), 0)
    );
    setLoadingData(false);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- состояние ставится после await, не синхронно
    loadObjects();
  }, [loadObjects]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- состояние ставится после await, не синхронно
    loadObjectData(objectId);
  }, [objectId, loadObjectData]);

  function changeObject(id: string) {
    setObjectId(id);
    setLineDetailId(null);
    setPaymentDetailId(null);
    writeSetting(LS_OBJECT_KEY, id);
  }

  /* ------------------------------ Производные суммы ------------------------------ */

  const bySection = useMemo(() => {
    const m = new Map<BudgetSection, { plan: number; fact: number; forecast: number; lines: BudgetLine[] }>();
    BUDGET_SECTIONS.forEach((s) => m.set(s, { plan: 0, fact: 0, forecast: 0, lines: [] }));
    lines.forEach((l) => {
      const cur = m.get(l.section);
      if (!cur) return;
      cur.plan += l.plan_amount;
      cur.fact += l.fact_amount;
      cur.forecast += budgetForecast(l);
      cur.lines.push(l);
    });
    return m;
  }, [lines]);

  const totals = useMemo(() => {
    let plan = 0,
      fact = 0,
      forecast = 0;
    bySection.forEach((v) => {
      plan += v.plan;
      fact += v.fact;
      forecast += v.forecast;
    });
    return { plan, fact, forecast, overrun: Math.round((forecast - plan) * 100) / 100 };
  }, [bySection]);

  const basisTotal = totals[basis] || 0;

  const settlement = useMemo(() => {
    const paid = payments.reduce((s, p) => s + p.amount, 0);
    const remainder = Math.round((signedActsSum - paid) * 100) / 100;
    return { accrued: signedActsSum, paid, remainder };
  }, [payments, signedActsSum]);

  const visibleSections = sectionFilter === "all" ? BUDGET_SECTIONS : [sectionFilter];

  /* ------------------------------ Статьи: панель ------------------------------ */

  function openLinePanel(id: string | null) {
    setEditingLineId(id);
    const l = id ? lines.find((x) => x.id === id) || null : null;
    setLineForm(lineToForm(l));
    setLinePanelOpen(true);
  }
  function closeLinePanel() {
    setLinePanelOpen(false);
    setEditingLineId(null);
  }

  async function saveLine() {
    if (!lineForm.name.trim()) {
      setBanner("Укажите наименование статьи.");
      return;
    }
    const plan = Number(lineForm.planAmount || 0);
    const fact = Number(lineForm.factAmount || 0);
    if (isNaN(plan) || plan < 0 || isNaN(fact) || fact < 0) {
      setBanner("План и факт — неотрицательные числа.");
      return;
    }
    const forecast = lineForm.forecastAmount.trim() === "" ? null : Number(lineForm.forecastAmount);
    if (forecast !== null && (isNaN(forecast) || forecast < 0)) {
      setBanner("Прогноз — неотрицательное число, либо оставьте поле пустым для авторасчёта.");
      return;
    }
    setBanner(null);
    setLineSaving(true);
    const now = new Date().toISOString();
    const payload = {
      object_id: objectId,
      section: lineForm.section,
      name: lineForm.name.trim(),
      plan_amount: plan,
      fact_amount: fact,
      forecast_amount: forecast,
      note: lineForm.note.trim() || null,
      updated_at: now,
    };

    if (editingLineId) {
      const old = lines.find((x) => x.id === editingLineId) || null;
      const parts: string[] = [];
      if (old?.section !== payload.section) parts.push(`Раздел: ${BUDGET_SECTION_LABEL[old!.section]} → ${BUDGET_SECTION_LABEL[payload.section]}`);
      if (old?.name !== payload.name) parts.push(`Название: ${old?.name} → ${payload.name}`);
      if (Number(old?.plan_amount) !== plan) parts.push(`План: ${fmtMoney(old?.plan_amount)} → ${fmtMoney(plan)}`);
      if (Number(old?.fact_amount) !== fact) parts.push(`Факт: ${fmtMoney(old?.fact_amount)} → ${fmtMoney(fact)}`);
      if ((old?.forecast_amount ?? null) !== forecast) parts.push(`Прогноз: ${old?.forecast_amount != null ? fmtMoney(old.forecast_amount) : "авто"} → ${forecast != null ? fmtMoney(forecast) : "авто"}`);
      const history: HistoryEntry[] = [...(old?.history || []), { at: now, text: parts.length ? parts.join("; ") : "Статья сохранена без изменений" }];
      const { error } = await supabase.from("budget_lines").update({ ...payload, history }).eq("id", editingLineId);
      if (error) setBanner(dbErrorText(error, "Не удалось сохранить статью"));
      else {
        closeLinePanel();
        await loadObjectData(objectId);
      }
    } else {
      const { error } = await supabase
        .from("budget_lines")
        .insert({ ...payload, created_at: now, history: [{ at: now, text: "Статья добавлена" }] });
      if (error) setBanner(dbErrorText(error, "Не удалось добавить статью"));
      else {
        closeLinePanel();
        await loadObjectData(objectId);
      }
    }
    setLineSaving(false);
  }

  async function deleteLine(id: string) {
    const { error } = await supabase.from("budget_lines").delete().eq("id", id);
    if (error) setBanner(dbErrorText(error, "Не удалось удалить статью"));
    else {
      if (lineDetailId === id) setLineDetailId(null);
      await loadObjectData(objectId);
    }
    setLinePendingDeleteId(null);
  }

  /* ------------------------------ Взаиморасчёты: панель ------------------------------ */

  function openPaymentPanel(id: string | null) {
    setEditingPaymentId(id);
    const p = id ? payments.find((x) => x.id === id) || null : null;
    setPaymentForm(paymentToForm(p));
    setPaymentPanelOpen(true);
  }
  function closePaymentPanel() {
    setPaymentPanelOpen(false);
    setEditingPaymentId(null);
  }

  async function savePayment() {
    if (!paymentForm.paymentDate) {
      setBanner("Укажите дату платежа.");
      return;
    }
    const amount = Number(paymentForm.amount);
    if (!paymentForm.amount || isNaN(amount) || amount < 0) {
      setBanner("Укажите сумму платежа.");
      return;
    }
    setBanner(null);
    setPaymentSaving(true);
    const now = new Date().toISOString();
    const payload = {
      object_id: objectId,
      payment_date: paymentForm.paymentDate,
      amount,
      document: paymentForm.document.trim() || null,
      note: paymentForm.note.trim() || null,
      updated_at: now,
    };

    if (editingPaymentId) {
      const old = payments.find((x) => x.id === editingPaymentId) || null;
      const parts: string[] = [];
      if (old?.payment_date !== payload.payment_date) parts.push(`Дата: ${fmtDate(old?.payment_date || null)} → ${fmtDate(payload.payment_date)}`);
      if (Number(old?.amount) !== amount) parts.push(`Сумма: ${fmtMoney(old?.amount)} → ${fmtMoney(amount)}`);
      if ((old?.document || "") !== (payload.document || "")) parts.push("Документ изменён");
      const history: HistoryEntry[] = [...(old?.history || []), { at: now, text: parts.length ? parts.join("; ") : "Платёж сохранён без изменений" }];
      const { error } = await supabase.from("customer_payments").update({ ...payload, history }).eq("id", editingPaymentId);
      if (error) setBanner(dbErrorText(error, "Не удалось сохранить платёж"));
      else {
        closePaymentPanel();
        await loadObjectData(objectId);
      }
    } else {
      const { error } = await supabase
        .from("customer_payments")
        .insert({ ...payload, created_at: now, history: [{ at: now, text: "Платёж зарегистрирован" }] });
      if (error) setBanner(dbErrorText(error, "Не удалось добавить платёж"));
      else {
        closePaymentPanel();
        await loadObjectData(objectId);
      }
    }
    setPaymentSaving(false);
  }

  async function deletePayment(id: string) {
    const { error } = await supabase.from("customer_payments").delete().eq("id", id);
    if (error) setBanner(dbErrorText(error, "Не удалось удалить платёж"));
    else {
      if (paymentDetailId === id) setPaymentDetailId(null);
      await loadObjectData(objectId);
    }
    setPaymentPendingDeleteId(null);
  }

  /* ------------------------------ Рендер ------------------------------ */

  const selectedObject = objects.find((o) => o.id === objectId) || null;

  return (
    <div>
      {banner && (
        <div className="banner show" onClick={() => setBanner(null)} role="status">
          {banner}
        </div>
      )}
      {schemaMissing && <SchemaSetup onRecheck={() => loadObjectData(objectId)} />}

      <div className="obj-picker">
        <label htmlFor="budget-object">Объект</label>
        <select
          id="budget-object"
          className="filter"
          value={objectId}
          onChange={(e) => changeObject(e.target.value)}
          disabled={loadingObjects || objects.length === 0}
        >
          {objects.length === 0 && <option value="">{loadingObjects ? "Загрузка…" : "Объектов нет"}</option>}
          {objects.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
        {selectedObject && <span className="obj-picker-meta">{selectedObject.address}</span>}
      </div>

      {!objectId ? (
        <div className="empty-state">Сначала создайте объект в модуле «Объекты».</div>
      ) : loadingData ? (
        <div className="empty-state">Загрузка…</div>
      ) : (
        <>
          <div className="stats">
            <div className="stat-total">
              <span className="n">{fmtMoney(totals.plan)}</span>
              <span className="l">план затрат</span>
            </div>
            <div className="chip-row">
              <span className="chip st-neutral">
                <span className="n">{fmtMoney(totals.fact)}</span> факт
                {totals.plan > 0 && <span className="chip-sub"> ({Math.round((totals.fact / totals.plan) * 100)}% плана)</span>}
              </span>
              <span className={`chip ${totals.overrun > 0 ? "st-bad" : "st-good"}`}>
                <span className="n">{fmtMoney(totals.forecast)}</span> прогноз
                {totals.overrun !== 0 && (
                  <span className="chip-sub"> ({totals.overrun > 0 ? "перерасход" : "экономия"} {fmtMoney(Math.abs(totals.overrun))})</span>
                )}
              </span>
              {orderedSupplySum > 0 && (
                <span className="chip st-neutral">
                  <span className="n">{fmtMoney(orderedSupplySum)}</span> заказано через снабжение
                </span>
              )}
            </div>
          </div>

          <div className="section-block">
            <h3 className="section-title">
              Структура затрат
              <div className="seg" role="tablist" aria-label="Основа диаграммы" style={{ marginLeft: "auto" }}>
                <button className={`seg-btn${basis === "plan" ? " active" : ""}`} onClick={() => setBasis("plan")}>
                  План
                </button>
                <button className={`seg-btn${basis === "fact" ? " active" : ""}`} onClick={() => setBasis("fact")}>
                  Факт
                </button>
                <button className={`seg-btn${basis === "forecast" ? " active" : ""}`} onClick={() => setBasis("forecast")}>
                  Прогноз
                </button>
              </div>
            </h3>

            {basisTotal > 0 && (
              <>
                <div className="bud-share">
                  {BUDGET_SECTIONS.map((s) => {
                    const v = bySection.get(s)![basis];
                    const pct = (v / basisTotal) * 100;
                    if (pct <= 0) return null;
                    return <div key={s} className="bud-share-seg" style={{ width: `${pct}%`, background: SECTION_VAR[s] }} title={BUDGET_SECTION_LABEL[s]} />;
                  })}
                </div>
                <div className="bud-legend">
                  {BUDGET_SECTIONS.map((s) => (
                    <span key={s}>
                      <i style={{ background: SECTION_VAR[s] }} />
                      {BUDGET_SECTION_LABEL[s]}: {fmtMoney(bySection.get(s)![basis])}
                    </span>
                  ))}
                </div>
              </>
            )}

            <div className="curve-card" style={{ marginTop: 14 }}>
              <div className="bud-rows">
                {BUDGET_SECTIONS.map((s) => {
                  const v = bySection.get(s)!;
                  const maxVal = Math.max(v.plan, v.fact, v.forecast, 1);
                  const planPct = (v.plan / maxVal) * 100;
                  const factPct = (v.fact / maxVal) * 100;
                  const forecastPct = (v.forecast / maxVal) * 100;
                  const over = v.fact > v.plan;
                  return (
                    <div className="bud-row" key={s}>
                      <div className="bud-row-label">
                        <i style={{ background: SECTION_VAR[s] }} />
                        {BUDGET_SECTION_LABEL[s]}
                      </div>
                      <div className="bud-track" title={`план ${fmtMoney(v.plan)} · факт ${fmtMoney(v.fact)} · прогноз ${fmtMoney(v.forecast)}`}>
                        <div className="bud-plan-zone" style={{ width: `${planPct}%` }} />
                        <div
                          className="bud-fact-fill"
                          style={{ width: `${factPct}%`, background: over ? "var(--st-bad-ink)" : SECTION_VAR[s] }}
                        />
                        <div className="bud-forecast-tick" style={{ left: `${forecastPct}%` }} />
                      </div>
                      <div className="bud-row-nums">
                        <span>план {fmtMoney(v.plan)}</span>
                        <span className={over ? "is-neg" : undefined}>факт {fmtMoney(v.fact)}</span>
                        <span>прогноз {fmtMoney(v.forecast)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
              <p className="hint">Пунктирная зона — план, сплошная заливка — факт (красным — сверх плана), вертикальная чёрточка — прогноз.</p>
            </div>
          </div>

          <div className="section-block">
            <h3 className="section-title">Статьи бюджета</h3>
            <div className="toolbar" style={{ padding: "0 0 14px" }}>
              <select className="filter" value={sectionFilter} onChange={(e) => setSectionFilter(e.target.value as SectionFilter)}>
                <option value="all">Все разделы</option>
                {BUDGET_SECTIONS.map((s) => (
                  <option key={s} value={s}>
                    {BUDGET_SECTION_LABEL[s]}
                  </option>
                ))}
              </select>
              <button className="btn btn-primary" onClick={() => openLinePanel(null)}>
                + Статья
              </button>
            </div>

            {lines.length === 0 ? (
              <div className="empty-state">Статей бюджета пока нет — добавьте первую.</div>
            ) : (
              <LinesTable
                bySection={bySection}
                visibleSections={visibleSections}
                detailId={lineDetailId}
                setDetailId={setLineDetailId}
                pendingDeleteId={linePendingDeleteId}
                setPendingDeleteId={setLinePendingDeleteId}
                onEdit={openLinePanel}
                onDelete={deleteLine}
              />
            )}
          </div>

          <div className="section-block">
            <h3 className="section-title">Взаиморасчёты с заказчиком</h3>
            <div className="bud-settle">
              <div className="bud-settle-card">
                <h4>Начислено</h4>
                <div className="v mono">{fmtMoney(settlement.accrued)}</div>
                <div className="sub">
                  сумма подписанных актов, <a href="/pto">раздел ПТО</a>
                </div>
              </div>
              <div className="bud-settle-card">
                <h4>Оплачено заказчиком</h4>
                <div className="v mono">{fmtMoney(settlement.paid)}</div>
                <div className="sub">{payments.length ? `${payments.length} ${plural(payments.length, "платёж", "платежа", "платежей")}` : "платежей ещё нет"}</div>
              </div>
              <div className="bud-settle-card">
                <h4>{settlement.remainder >= 0 ? "Остаток" : "Аванс не закрыт актами"}</h4>
                <div className={`v mono${settlement.remainder < 0 ? " is-pos" : settlement.remainder > 0 ? " is-neg" : ""}`}>
                  {fmtMoney(Math.abs(settlement.remainder))}
                </div>
              </div>
            </div>

            <div className="toolbar" style={{ padding: "0 0 14px" }}>
              <button className="btn btn-primary" onClick={() => openPaymentPanel(null)}>
                + Платёж
              </button>
            </div>

            {payments.length === 0 ? (
              <div className="empty-state">Платежей заказчика пока нет.</div>
            ) : (
              <PaymentsTable
                items={payments}
                detailId={paymentDetailId}
                setDetailId={setPaymentDetailId}
                pendingDeleteId={paymentPendingDeleteId}
                setPendingDeleteId={setPaymentPendingDeleteId}
                onEdit={openPaymentPanel}
                onDelete={deletePayment}
              />
            )}
          </div>
        </>
      )}

      {/* ---- Панель статьи бюджета ---- */}
      <div className={`overlay${linePanelOpen ? " show" : ""}`} onClick={closeLinePanel} />
      <div className={`panel${linePanelOpen ? " show" : ""}`}>
        <div className="panel-head">
          <h3>{editingLineId ? "Изменить статью" : "Новая статья бюджета"}</h3>
          <button className="panel-close" aria-label="Закрыть" onClick={closeLinePanel}>
            ✕
          </button>
        </div>
        <div className="panel-body">
          <div className="field">
            <label>Раздел</label>
            <select value={lineForm.section} onChange={(e) => setLineForm({ ...lineForm, section: e.target.value as BudgetSection })}>
              {BUDGET_SECTIONS.map((s) => (
                <option key={s} value={s}>
                  {BUDGET_SECTION_LABEL[s]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>
              Наименование <span className="req">*</span>
            </label>
            <input type="text" placeholder="напр. Металлоконструкции силоса" value={lineForm.name} onChange={(e) => setLineForm({ ...lineForm, name: e.target.value })} />
          </div>
          <div className="field-row">
            <div className="field">
              <label>План, ₽</label>
              <input type="number" min={0} value={lineForm.planAmount} onChange={(e) => setLineForm({ ...lineForm, planAmount: e.target.value })} />
            </div>
            <div className="field">
              <label>Факт, ₽</label>
              <input type="number" min={0} value={lineForm.factAmount} onChange={(e) => setLineForm({ ...lineForm, factAmount: e.target.value })} />
            </div>
          </div>
          <div className="field">
            <label>Прогноз, ₽</label>
            <input
              type="number"
              min={0}
              placeholder="пусто — авторасчёт"
              value={lineForm.forecastAmount}
              onChange={(e) => setLineForm({ ...lineForm, forecastAmount: e.target.value })}
            />
            <p className="hint">Пустое поле — прогноз считается сам: не меньше плана и не меньше факта.</p>
          </div>
          <div className="field">
            <label>Примечание</label>
            <textarea value={lineForm.note} onChange={(e) => setLineForm({ ...lineForm, note: e.target.value })} />
          </div>
        </div>
        <div className="panel-foot">
          <button className="btn btn-ghost" onClick={closeLinePanel}>
            Отмена
          </button>
          <button className="btn btn-primary" onClick={saveLine} disabled={lineSaving}>
            {lineSaving ? "Сохранение…" : "Сохранить"}
          </button>
        </div>
      </div>

      {/* ---- Панель платежа ---- */}
      <div className={`overlay${paymentPanelOpen ? " show" : ""}`} onClick={closePaymentPanel} />
      <div className={`panel${paymentPanelOpen ? " show" : ""}`}>
        <div className="panel-head">
          <h3>{editingPaymentId ? "Изменить платёж" : "Новый платёж заказчика"}</h3>
          <button className="panel-close" aria-label="Закрыть" onClick={closePaymentPanel}>
            ✕
          </button>
        </div>
        <div className="panel-body">
          <div className="field-row">
            <div className="field">
              <label>
                Дата <span className="req">*</span>
              </label>
              <input type="date" value={paymentForm.paymentDate} onChange={(e) => setPaymentForm({ ...paymentForm, paymentDate: e.target.value })} />
            </div>
            <div className="field">
              <label>
                Сумма, ₽ <span className="req">*</span>
              </label>
              <input type="number" min={0} value={paymentForm.amount} onChange={(e) => setPaymentForm({ ...paymentForm, amount: e.target.value })} />
            </div>
          </div>
          <div className="field">
            <label>Документ</label>
            <input type="text" placeholder="напр. платёжное поручение №118" value={paymentForm.document} onChange={(e) => setPaymentForm({ ...paymentForm, document: e.target.value })} />
          </div>
          <div className="field">
            <label>Примечание</label>
            <textarea value={paymentForm.note} onChange={(e) => setPaymentForm({ ...paymentForm, note: e.target.value })} />
          </div>
        </div>
        <div className="panel-foot">
          <button className="btn btn-ghost" onClick={closePaymentPanel}>
            Отмена
          </button>
          <button className="btn btn-primary" onClick={savePayment} disabled={paymentSaving}>
            {paymentSaving ? "Сохранение…" : "Сохранить"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================== Подвиды ============================== */

function LinesTable({
  bySection,
  visibleSections,
  detailId,
  setDetailId,
  pendingDeleteId,
  setPendingDeleteId,
  onEdit,
  onDelete,
}: {
  bySection: Map<BudgetSection, { plan: number; fact: number; forecast: number; lines: BudgetLine[] }>;
  visibleSections: BudgetSection[];
  detailId: string | null;
  setDetailId: (id: string | null) => void;
  pendingDeleteId: string | null;
  setPendingDeleteId: (id: string | null) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  function renderDetail(l: BudgetLine) {
    const history = (l.history || []).slice().reverse();
    const forecast = budgetForecast(l);
    return (
      <div className="detail">
        <div className="detail-block">
          <h4>Статья</h4>
          <dl>
            <dt>Раздел</dt>
            <dd>{BUDGET_SECTION_LABEL[l.section]}</dd>
            <dt>План</dt>
            <dd className="mono">{fmtMoney(l.plan_amount)}</dd>
            <dt>Факт</dt>
            <dd className={`mono${l.fact_amount > l.plan_amount ? " is-neg" : ""}`}>{fmtMoney(l.fact_amount)}</dd>
            <dt>Прогноз</dt>
            <dd className="mono">
              {fmtMoney(forecast)}
              {l.forecast_amount == null && <span className="bud-auto">авто</span>}
            </dd>
            {l.note && (
              <>
                <dt>Примечание</dt>
                <dd>{l.note}</dd>
              </>
            )}
          </dl>
          <div className="detail-actions">
            <button
              className="btn btn-sm btn-ghost"
              onClick={(ev) => {
                ev.stopPropagation();
                onEdit(l.id);
              }}
            >
              Изменить
            </button>
            {pendingDeleteId === l.id ? (
              <button
                className="btn btn-sm btn-danger"
                onClick={(ev) => {
                  ev.stopPropagation();
                  onDelete(l.id);
                }}
              >
                Точно удалить?
              </button>
            ) : (
              <button
                className="btn btn-sm btn-ghost"
                onClick={(ev) => {
                  ev.stopPropagation();
                  setPendingDeleteId(l.id);
                }}
              >
                Удалить
              </button>
            )}
          </div>
        </div>
        <div className="detail-block">
          <h4>История изменений</h4>
          {history.length ? (
            <ul className="history-list">
              {history.map((h, i) => (
                <li key={i}>
                  <time>{fmtDateTime(h.at)}</time>
                  {h.text}
                </li>
              ))}
            </ul>
          ) : (
            <p className="hint">Истории изменений пока нет.</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Наименование</th>
            <th>План</th>
            <th>Факт</th>
            <th>Прогноз</th>
            <th>Прогноз − план</th>
          </tr>
        </thead>
        <tbody>
          {visibleSections.map((s) => {
            const v = bySection.get(s)!;
            if (v.lines.length === 0) return null;
            return (
              <Fragment key={s}>
                <tr className="bud-group-head">
                  <td colSpan={5}>{BUDGET_SECTION_LABEL[s]}</td>
                </tr>
                {v.lines
                  .slice()
                  .sort((a, b) => a.name.localeCompare(b.name, "ru"))
                  .map((l) => {
                    const forecast = budgetForecast(l);
                    const dev = Math.round((forecast - l.plan_amount) * 100) / 100;
                    return (
                      <Fragment key={l.id}>
                        <tr className="obj-row" onClick={() => setDetailId(detailId === l.id ? null : l.id)}>
                          <td className="name-cell">{l.name}</td>
                          <td className="mono">{fmtMoney(l.plan_amount)}</td>
                          <td className={`mono${l.fact_amount > l.plan_amount ? " is-neg" : ""}`}>{fmtMoney(l.fact_amount)}</td>
                          <td className="mono">
                            {fmtMoney(forecast)}
                            {l.forecast_amount == null && <span className="bud-auto">авто</span>}
                          </td>
                          <td className={`mono${dev > 0 ? " is-neg" : dev < 0 ? " is-pos" : ""}`}>
                            {dev === 0 ? "—" : `${dev > 0 ? "+" : "−"}${fmtMoney(Math.abs(dev))}`}
                          </td>
                        </tr>
                        {detailId === l.id && (
                          <tr className="detail-row">
                            <td colSpan={5}>{renderDetail(l)}</td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                <tr className="bud-group-foot">
                  <td>Подытог</td>
                  <td className="mono">{fmtMoney(v.plan)}</td>
                  <td className="mono">{fmtMoney(v.fact)}</td>
                  <td className="mono">{fmtMoney(v.forecast)}</td>
                  <td className="mono">{fmtMoney(Math.round((v.forecast - v.plan) * 100) / 100)}</td>
                </tr>
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PaymentsTable({
  items,
  detailId,
  setDetailId,
  pendingDeleteId,
  setPendingDeleteId,
  onEdit,
  onDelete,
}: {
  items: CustomerPayment[];
  detailId: string | null;
  setDetailId: (id: string | null) => void;
  pendingDeleteId: string | null;
  setPendingDeleteId: (id: string | null) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  function renderDetail(p: CustomerPayment) {
    const history = (p.history || []).slice().reverse();
    return (
      <div className="detail">
        <div className="detail-block">
          <h4>Платёж</h4>
          <dl>
            <dt>Дата</dt>
            <dd className="mono">{fmtDate(p.payment_date)}</dd>
            <dt>Сумма</dt>
            <dd className="mono">{fmtMoney(p.amount)}</dd>
            <dt>Документ</dt>
            <dd>{p.document || "—"}</dd>
            {p.note && (
              <>
                <dt>Примечание</dt>
                <dd>{p.note}</dd>
              </>
            )}
          </dl>
          <div className="detail-actions">
            <button
              className="btn btn-sm btn-ghost"
              onClick={(ev) => {
                ev.stopPropagation();
                onEdit(p.id);
              }}
            >
              Изменить
            </button>
            {pendingDeleteId === p.id ? (
              <button
                className="btn btn-sm btn-danger"
                onClick={(ev) => {
                  ev.stopPropagation();
                  onDelete(p.id);
                }}
              >
                Точно удалить?
              </button>
            ) : (
              <button
                className="btn btn-sm btn-ghost"
                onClick={(ev) => {
                  ev.stopPropagation();
                  setPendingDeleteId(p.id);
                }}
              >
                Удалить
              </button>
            )}
          </div>
        </div>
        <div className="detail-block">
          <h4>История изменений</h4>
          {history.length ? (
            <ul className="history-list">
              {history.map((h, i) => (
                <li key={i}>
                  <time>{fmtDateTime(h.at)}</time>
                  {h.text}
                </li>
              ))}
            </ul>
          ) : (
            <p className="hint">Истории изменений пока нет.</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Дата</th>
              <th>Сумма</th>
              <th>Документ</th>
              <th>Примечание</th>
            </tr>
          </thead>
          <tbody>
            {items.map((p) => (
              <Fragment key={p.id}>
                <tr className="obj-row" onClick={() => setDetailId(detailId === p.id ? null : p.id)}>
                  <td className="mono">{fmtDate(p.payment_date)}</td>
                  <td className="mono">{fmtMoney(p.amount)}</td>
                  <td>{p.document || "—"}</td>
                  <td className="addr-cell">{p.note || "—"}</td>
                </tr>
                {detailId === p.id && (
                  <tr className="detail-row">
                    <td colSpan={4}>{renderDetail(p)}</td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <div className="cards">
        {items.map((p) => (
          <div className="obj-card" key={p.id} onClick={() => setDetailId(detailId === p.id ? null : p.id)}>
            <div className="row1">
              <div>
                <div className="cname">{fmtMoney(p.amount)}</div>
                <div className="caddr">{fmtDate(p.payment_date)}</div>
              </div>
            </div>
            {p.document && (
              <div className="cmeta">
                <span>{p.document}</span>
              </div>
            )}
            {detailId === p.id && renderDetail(p)}
          </div>
        ))}
      </div>
    </>
  );
}

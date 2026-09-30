"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { dbErrorText, needsSchemaSetup } from "@/lib/dbError";
import {
  AcceptanceAct,
  AcceptanceStatus,
  BudgetLine,
  CustomerPayment,
  ACCEPTANCE_STATUS_LABEL,
  ConstructionObject,
  HistoryEntry,
  ScheduleTask,
  WeeklyAssignment,
  WeeklyItem,
} from "@/lib/types";
import { TaskNode } from "@/lib/schedule";
import { computeObjectFinance, ObjectFinance } from "@/lib/finance";
import {
  ACCEPTANCE_OVERDUE_DAYS,
  computeObjectHealth,
  computeProductionCurve,
  computeTopRisks,
  CurvePoint,
  ObjectHealth,
  RISK_CLASS,
  RISK_LABEL,
} from "@/lib/portfolioHealth";
import { fmtDate, fmtMoney, fmtPercent, plural } from "@/lib/format";
import { OBJECT_KEY, readSetting, useToday, writeSetting } from "@/lib/useClient";

/** Выбор на дашборде, включая «Все объекты» (пустая строка). */
const DASH_OBJECT_KEY = "atr.dashboard.objectId";
import SchemaSetup from "@/components/SchemaSetup";

interface PendingFlat {
  objectId: string;
  objectName: string;
  task: TaskNode;
  daysWaiting: number | null;
}

interface AcceptForm {
  status: AcceptanceStatus;
  actNumber: string;
  actDate: string;
  amount: string;
}

const EMPTY_ACCEPT_FORM: AcceptForm = { status: "draft", actNumber: "", actDate: "", amount: "" };

/** Результат со знаком: минус — убыток (красный), плюс — прибыль (зелёный). */
const fmtSigned = (n: number | null): string =>
  n === null ? "—" : n === 0 ? "0 ₽" : `${n > 0 ? "+" : "−"}${fmtMoney(Math.abs(n))}`;
const signClass = (n: number | null): string => (n === null || n === 0 ? "" : n < 0 ? " is-neg" : " is-pos");

export default function PortfolioHealth() {
  const today = useToday();

  const [objects, setObjects] = useState<ConstructionObject[]>([]);
  const [tasksByObject, setTasksByObject] = useState<Map<string, ScheduleTask[]>>(new Map());
  const [weekItemsByObject, setWeekItemsByObject] = useState<Map<string, WeeklyItem[]>>(new Map());
  const [actsByObject, setActsByObject] = useState<Map<string, AcceptanceAct[]>>(new Map());
  const [budgetByObject, setBudgetByObject] = useState<Map<string, BudgetLine[]>>(new Map());
  const [paymentsByObject, setPaymentsByObject] = useState<Map<string, CustomerPayment[]>>(new Map());

  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState<string | null>(null);
  const [schemaMissing, setSchemaMissing] = useState(false);

  const [openAcceptTaskId, setOpenAcceptTaskId] = useState<string | null>(null);
  const [acceptForm, setAcceptForm] = useState<AcceptForm>(EMPTY_ACCEPT_FORM);
  const [acceptBusy, setAcceptBusy] = useState(false);

  /** "" — показывать портфель целиком; иначе id объекта, на котором развёрнута сводка. */
  const [selectedObjectId, setSelectedObjectId] = useState<string>("");

  const loadAll = useCallback(async () => {
    setLoading(true);
    setBanner(null);

    const { data: objs, error: objErr } = await supabase
      .from("objects")
      .select("*")
      .order("created_at", { ascending: false });
    if (objErr) {
      setBanner(dbErrorText(objErr, "Не удалось загрузить объекты"));
      setSchemaMissing(needsSchemaSetup(objErr));
      setLoading(false);
      return;
    }
    const objectList = (objs || []) as ConstructionObject[];
    setObjects(objectList);
    // Дашборд помнит свой выбор; если его ещё не было — берёт объект, открытый на остальных вкладках.
    const savedDash = readSetting(DASH_OBJECT_KEY);
    const saved = savedDash !== null ? savedDash : readSetting(OBJECT_KEY) || "";
    setSelectedObjectId(objectList.some((o) => o.id === saved) ? saved : "");
    setSchemaMissing(false);

    if (!objectList.length) {
      setTasksByObject(new Map());
      setWeekItemsByObject(new Map());
      setActsByObject(new Map());
      setLoading(false);
      return;
    }

    const [taskRes, asgRes, actRes, budgetRes, payRes] = await Promise.all([
      supabase.from("schedule_tasks").select("*").order("sort_order", { ascending: true }),
      supabase.from("weekly_assignments").select("*").order("week_start", { ascending: false }),
      supabase.from("acceptance_acts").select("*"),
      supabase.from("budget_lines").select("*"),
      supabase.from("customer_payments").select("object_id,amount"),
    ]);
    const groupByObject = <T extends { object_id: string }>(rows: T[] | null): Map<string, T[]> => {
      const m = new Map<string, T[]>();
      (rows || []).forEach((r) => {
        const list = m.get(r.object_id);
        if (list) list.push(r);
        else m.set(r.object_id, [r]);
      });
      return m;
    };
    // Финансы — дополнительный блок: если таблиц ещё нет, остальной дашборд работает как раньше.
    setBudgetByObject(budgetRes.error ? new Map() : groupByObject(budgetRes.data as BudgetLine[]));
    setPaymentsByObject(payRes.error ? new Map() : groupByObject(payRes.data as CustomerPayment[]));

    if (taskRes.error) {
      setBanner(dbErrorText(taskRes.error, "Не удалось загрузить график"));
      setSchemaMissing(needsSchemaSetup(taskRes.error));
      setLoading(false);
      return;
    }

    const tByObj = new Map<string, ScheduleTask[]>();
    (taskRes.data || []).forEach((t: ScheduleTask) => {
      const list = tByObj.get(t.object_id);
      if (list) list.push(t);
      else tByObj.set(t.object_id, [t]);
    });
    setTasksByObject(tByObj);

    // Последнее (самое свежее) задание на неделю по каждому объекту.
    const latestAssignmentByObject = new Map<string, WeeklyAssignment>();
    if (!asgRes.error) {
      (asgRes.data || []).forEach((a: WeeklyAssignment) => {
        if (!latestAssignmentByObject.has(a.object_id)) latestAssignmentByObject.set(a.object_id, a);
      });
    }
    const latestIds = Array.from(latestAssignmentByObject.values()).map((a) => a.id);
    const wByObj = new Map<string, WeeklyItem[]>();
    if (latestIds.length) {
      const { data: items, error: itemErr } = await supabase
        .from("weekly_items")
        .select("*")
        .in("assignment_id", latestIds);
      if (!itemErr) {
        const assignmentToObject = new Map<string, string>();
        latestAssignmentByObject.forEach((a) => assignmentToObject.set(a.id, a.object_id));
        (items || []).forEach((it: WeeklyItem) => {
          const objId = assignmentToObject.get(it.assignment_id);
          if (!objId) return;
          const list = wByObj.get(objId);
          if (list) list.push(it);
          else wByObj.set(objId, [it]);
        });
      }
    }
    setWeekItemsByObject(wByObj);

    const aByObj = new Map<string, AcceptanceAct[]>();
    if (!actRes.error) {
      (actRes.data || []).forEach((a: AcceptanceAct) => {
        const list = aByObj.get(a.object_id);
        if (list) list.push(a);
        else aByObj.set(a.object_id, [a]);
      });
    } else if (needsSchemaSetup(actRes.error)) {
      setSchemaMissing(true);
    }
    setActsByObject(aByObj);

    setLoading(false);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- состояние ставится после await, не синхронно
    loadAll();
  }, [loadAll]);

  const healths: ObjectHealth[] = useMemo(() => {
    if (!today) return [];
    return objects.map((o) =>
      computeObjectHealth(o, tasksByObject.get(o.id) || [], weekItemsByObject.get(o.id) || null, actsByObject.get(o.id) || [], today)
    );
  }, [objects, tasksByObject, weekItemsByObject, actsByObject, today]);

  /** Карта здоровья и топ риска — либо весь портфель, либо один выбранный объект. */
  const visibleHealths = useMemo(
    () => (selectedObjectId ? healths.filter((h) => h.object.id === selectedObjectId) : healths),
    [healths, selectedObjectId]
  );

  const finances: ObjectFinance[] = useMemo(
    () =>
      objects.map((o) =>
        computeObjectFinance(o, budgetByObject.get(o.id) || [], tasksByObject.get(o.id) || [], paymentsByObject.get(o.id) || [])
      ),
    [objects, budgetByObject, tasksByObject, paymentsByObject]
  );
  const visibleFinances = useMemo(
    () => (selectedObjectId ? finances.filter((f) => f.object.id === selectedObjectId) : finances),
    [finances, selectedObjectId]
  );
  /** Итог портфеля — только по объектам, где есть и договор, и бюджет. */
  const financeTotal = useMemo(() => {
    const ready = finances.filter((f) => f.resultForecast !== null);
    const sum = (pick: (f: ObjectFinance) => number) => Math.round(ready.reduce((s, f) => s + pick(f), 0) * 100) / 100;
    return {
      count: ready.length,
      contract: sum((f) => f.contract || 0),
      plan: sum((f) => f.plan),
      fact: sum((f) => f.fact),
      forecast: sum((f) => f.forecast),
      resultPlan: sum((f) => f.resultPlan || 0),
      resultForecast: sum((f) => f.resultForecast || 0),
      paid: sum((f) => f.paid),
      cashGap: sum((f) => f.cashGap),
    };
  }, [finances]);

  const topRisks = useMemo(() => computeTopRisks(visibleHealths), [visibleHealths]);

  const curve: CurvePoint[] = useMemo(() => {
    if (!today) return [];
    const objs = selectedObjectId ? objects.filter((o) => o.id === selectedObjectId) : objects;
    return computeProductionCurve(objs, tasksByObject, actsByObject, today);
  }, [objects, tasksByObject, actsByObject, today, selectedObjectId]);

  const riskCounts = useMemo(() => {
    const c = { critical: 0, warning: 0, ok: 0 };
    healths.forEach((h) => {
      c[h.risk]++;
    });
    return c;
  }, [healths]);

  const totalFrozen = useMemo(() => healths.reduce((s, h) => s + h.frozenMoney, 0), [healths]);

  const pendingFlat: PendingFlat[] = useMemo(() => {
    const out: PendingFlat[] = [];
    healths.forEach((h) => {
      h.pendingAcceptance.forEach((p) => {
        out.push({ objectId: h.object.id, objectName: h.object.name, task: p.task, daysWaiting: p.daysWaiting });
      });
    });
    return out.sort((a, b) => (b.daysWaiting ?? -1) - (a.daysWaiting ?? -1));
  }, [healths]);

  const visiblePendingFlat = useMemo(
    () => (selectedObjectId ? pendingFlat.filter((p) => p.objectId === selectedObjectId) : pendingFlat),
    [pendingFlat, selectedObjectId]
  );

  const selectedObject = useMemo(
    () => objects.find((o) => o.id === selectedObjectId) || null,
    [objects, selectedObjectId]
  );

  const actsByTaskId = useMemo(() => {
    const m = new Map<string, AcceptanceAct>();
    actsByObject.forEach((list) => list.forEach((a) => m.set(a.task_id, a)));
    return m;
  }, [actsByObject]);

  const openAccept = (p: PendingFlat) => {
    const existing = actsByTaskId.get(p.task.task.id);
    setOpenAcceptTaskId(p.task.task.id);
    setAcceptForm({
      status: existing?.status || "draft",
      actNumber: existing?.act_number || "",
      actDate: existing?.act_date || today || "",
      amount: existing?.amount != null ? String(existing.amount) : p.task.costTotal != null ? String(p.task.costTotal) : "",
    });
  };

  const closeAccept = () => setOpenAcceptTaskId(null);

  const saveAccept = async (p: PendingFlat) => {
    setAcceptBusy(true);
    const existing = actsByTaskId.get(p.task.task.id);
    const amountNum = acceptForm.amount === "" ? null : Number(acceptForm.amount);
    const prevText = existing
      ? `${ACCEPTANCE_STATUS_LABEL[existing.status]}${existing.act_number ? ", №" + existing.act_number : ""}`
      : "не открыт";
    const nextText = `${ACCEPTANCE_STATUS_LABEL[acceptForm.status]}${acceptForm.actNumber ? ", №" + acceptForm.actNumber : ""}`;
    const history: HistoryEntry[] = [
      ...(existing?.history || []),
      { at: new Date().toISOString(), text: `Акт по этапу «${p.task.task.name}»: ${prevText} → ${nextText}` },
    ];
    const { error } = await supabase.from("acceptance_acts").upsert(
      {
        task_id: p.task.task.id,
        object_id: p.objectId,
        status: acceptForm.status,
        act_number: acceptForm.actNumber || null,
        act_date: acceptForm.actDate || null,
        amount: amountNum,
        history,
      },
      { onConflict: "task_id" }
    );
    setAcceptBusy(false);
    if (error) {
      setBanner(dbErrorText(error, "Не удалось сохранить акт"));
      setSchemaMissing(needsSchemaSetup(error));
      return;
    }
    setOpenAcceptTaskId(null);
    loadAll();
  };

  const markSigned = async (p: PendingFlat) => {
    setAcceptBusy(true);
    const existing = actsByTaskId.get(p.task.task.id);
    const history: HistoryEntry[] = [
      ...(existing?.history || []),
      { at: new Date().toISOString(), text: `Акт по этапу «${p.task.task.name}»: отмечен принятым` },
    ];
    const { error } = await supabase.from("acceptance_acts").upsert(
      {
        task_id: p.task.task.id,
        object_id: p.objectId,
        status: "signed",
        act_number: existing?.act_number || null,
        act_date: today,
        amount: existing?.amount ?? p.task.costTotal ?? 0,
        history,
      },
      { onConflict: "task_id" }
    );
    setAcceptBusy(false);
    if (error) {
      setBanner(dbErrorText(error, "Не удалось отметить акт"));
      setSchemaMissing(needsSchemaSetup(error));
      return;
    }
    loadAll();
  };

  const chartMax = useMemo(() => {
    let m = 0;
    curve.forEach((c) => {
      m = Math.max(m, c.plan, c.fact, c.acted);
    });
    return m || 1;
  }, [curve]);

  const linePath = (pick: (c: CurvePoint) => number): string => {
    if (curve.length === 0) return "";
    const stepX = curve.length > 1 ? 600 / (curve.length - 1) : 0;
    return curve
      .map((c, i) => {
        const x = 20 + i * stepX;
        const y = 190 - (pick(c) / chartMax) * 170;
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  };

  if (loading && !objects.length) {
    return <p className="hint">Загрузка портфеля…</p>;
  }

  return (
    <div>
      {banner && <div className="banner show">{banner}</div>}
      {schemaMissing && <SchemaSetup onRecheck={loadAll} />}

      {objects.length > 0 && (
        <div className="obj-picker">
          <label htmlFor="dash-object">Объект</label>
          <select
            id="dash-object"
            className="filter"
            value={selectedObjectId}
            onChange={(e) => {
              setSelectedObjectId(e.target.value);
              writeSetting(DASH_OBJECT_KEY, e.target.value);
              // Конкретный объект открывается и на остальных вкладках; «Все объекты» их не трогает.
              if (e.target.value) writeSetting(OBJECT_KEY, e.target.value);
            }}
          >
            <option value="">Все объекты</option>
            {objects.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
          {selectedObject && <span className="obj-picker-meta">{selectedObject.address}</span>}
        </div>
      )}

      <div className="stats">
        <div className="stat-total">
          <span className="n">{objects.length}</span>
          <span className="l">объектов в портфеле</span>
        </div>
        <div className="chip-row">
          <span className="chip st-bad">
            <span className="n">{riskCounts.critical}</span> критичных
          </span>
          <span className="chip st-warn">
            <span className="n">{riskCounts.warning}</span> требуют внимания
          </span>
          <span className="chip st-good">
            <span className="n">{riskCounts.ok}</span> в норме
          </span>
          {totalFrozen > 0 && (
            <span className="chip st-neutral">
              <span className="n">{fmtMoney(totalFrozen)}</span> заморожено без акта
            </span>
          )}
        </div>
      </div>

      <section className="section-block">
        <h3 className="section-title">Финансы{selectedObject ? `: ${selectedObject.name}` : ""}</h3>
        <p className="hint fin-hint">
          Смета — наша себестоимость, договор — выручка. Прогноз затрат: по закрытым работам — факт, по остальным — не меньше
          сметы; накладные — по смете до завершения объекта.
        </p>
        {!objects.length ? null : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Объект</th>
                    <th>Договор</th>
                    <th>Смета</th>
                    <th>Факт затрат</th>
                    <th>Прогноз затрат</th>
                    <th title="Договор − смета: с каким результатом объект взят">Результат по смете</th>
                    <th title="Договор − прогноз затрат: чем объект закончится при текущем раскладе">Результат прогноз</th>
                    <th>Получено от заказчика</th>
                    <th title="Плюс — объект финансируется из своих денег">Затраты − оплаты</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleFinances.map((f) => (
                    <tr key={f.object.id} className="obj-row">
                      <td className="name-cell">
                        {f.object.name}
                        {f.warnings.length > 0 && <div className="fin-warn">{f.warnings.join("; ")}</div>}
                      </td>
                      <td className="mono">{f.contract ? fmtMoney(f.contract) : "—"}</td>
                      <td className="mono">{f.hasBudget ? fmtMoney(f.plan) : "—"}</td>
                      <td className="mono">{f.hasBudget ? fmtMoney(f.fact) : "—"}</td>
                      <td className="mono">{f.hasBudget ? fmtMoney(f.forecast) : "—"}</td>
                      <td className={`mono${signClass(f.resultPlan)}`}>{fmtSigned(f.resultPlan)}</td>
                      <td className={`mono${signClass(f.resultForecast)}`}>{fmtSigned(f.resultForecast)}</td>
                      <td className="mono">{f.hasPayments ? fmtMoney(f.paid) : <span className="fin-muted">не внесено</span>}</td>
                      <td className={`mono${f.hasPayments && f.cashGap > 0 ? " is-neg" : ""}`}>
                        {f.hasPayments ? fmtMoney(f.cashGap) : <span className="fin-muted">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
                {!selectedObject && finances.length > 1 && (
                  <tfoot>
                    <tr className="bud-total-row">
                      <td>
                        Итого{" "}
                        <span className="fin-muted">
                          ({financeTotal.count} из {finances.length} — объекты с договором и бюджетом)
                        </span>
                      </td>
                      <td className="mono">{fmtMoney(financeTotal.contract)}</td>
                      <td className="mono">{fmtMoney(financeTotal.plan)}</td>
                      <td className="mono">{fmtMoney(financeTotal.fact)}</td>
                      <td className="mono">{fmtMoney(financeTotal.forecast)}</td>
                      <td className={`mono${signClass(financeTotal.resultPlan)}`}>{fmtSigned(financeTotal.resultPlan)}</td>
                      <td className={`mono${signClass(financeTotal.resultForecast)}`}>
                        {fmtSigned(financeTotal.resultForecast)}
                      </td>
                      <td className="mono">{fmtMoney(financeTotal.paid)}</td>
                      <td className="mono">{fmtMoney(financeTotal.cashGap)}</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
            <div className="cards">
              {visibleFinances.map((f) => (
                <div className="obj-card" key={f.object.id}>
                  <div className="row1">
                    <div className="cname">{f.object.name}</div>
                    <span className={`mono fin-result${signClass(f.resultForecast)}`}>{fmtSigned(f.resultForecast)}</span>
                  </div>
                  <div className="cmeta">
                    <span>Договор: {f.contract ? fmtMoney(f.contract) : "—"}</span>
                    {f.hasBudget && <span>Смета: {fmtMoney(f.plan)}</span>}
                    {f.hasBudget && <span>Факт: {fmtMoney(f.fact)}</span>}
                    {f.hasBudget && <span>Прогноз затрат: {fmtMoney(f.forecast)}</span>}
                    <span>
                      По смете: <span className={signClass(f.resultPlan).trim()}>{fmtSigned(f.resultPlan)}</span>
                    </span>
                    <span>Получено: {f.hasPayments ? fmtMoney(f.paid) : "не внесено"}</span>
                  </div>
                  {f.warnings.length > 0 && <div className="fin-warn">{f.warnings.join("; ")}</div>}
                </div>
              ))}
            </div>
            {visibleFinances
              .filter((f) => f.resultForecast !== null)
              .map((f) => (
                <p key={f.object.id} className="fin-note">
                  <b>{f.object.name}:</b> по закрытым работам{" "}
                  {f.lockedSaving >= 0 ? "экономия" : "перерасход"}{" "}
                  <span className={signClass(f.lockedSaving).trim()}>{fmtSigned(f.lockedSaving)}</span> — это уже не
                  изменится. Осталось потратить по смете {fmtMoney(f.remainingPlan)}.{" "}
                  {f.toBreakEven > 0 ? (
                    <>
                      Чтобы выйти в ноль, на оставшемся нужно сэкономить{" "}
                      <span className="is-neg">{fmtMoney(f.toBreakEven)}</span>
                      {f.remainingPlan > 0 && ` (${fmtPercent((f.toBreakEven / f.remainingPlan) * 100)} остатка)`}.
                    </>
                  ) : (
                    <>При текущем раскладе объект выходит в плюс.</>
                  )}
                </p>
              ))}
          </>
        )}
      </section>

      <section className="section-block">
        <h3 className="section-title">{selectedObject ? "Причины риска" : "Топ причин риска"}</h3>
        {topRisks.length === 0 ? (
          <p className="hint">Системных причин отставания не выявлено.</p>
        ) : (
          <ul className="risk-list">
            {topRisks.map((r) => (
              <li key={r.text} className="risk-item">
                <span className="chip st-bad">
                  <span className="n">{r.count}</span>
                </span>
                <div className="risk-text">
                  <div className="risk-headline">{r.text}</div>
                  <div className="risk-objects">{r.objects.join(", ")}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="section-block">
        <h3 className="section-title">{selectedObject ? `Здоровье объекта: ${selectedObject.name}` : "Карта здоровья объектов"}</h3>
        {!objects.length ? (
          <p className="empty-state">Объектов пока нет — заведите первый в разделе «Объекты».</p>
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Объект</th>
                    <th>Этапы графика</th>
                    <th>% план / факт</th>
                    <th>Неделя</th>
                    <th>Заморожено</th>
                    <th>Причины</th>
                    <th>Риск</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleHealths.map((h) => (
                    <tr key={h.object.id} className="obj-row">
                      <td className="name-cell">{h.object.name}</td>
                      <td>
                        <div className="chip-row" title="в графике / отставание / закрыто">
                          <span className="chip st-good">
                            <span className="n">{h.schedule.onTrack}</span>
                          </span>
                          <span className="chip st-bad">
                            <span className="n">{h.schedule.behind}</span>
                          </span>
                          <span className="chip st-neutral">
                            <span className="n">{h.schedule.closed}</span>
                          </span>
                        </div>
                      </td>
                      <td className="mono">
                        {fmtPercent(h.schedule.progressPlan)} / {fmtPercent(h.schedule.progressFact)}
                      </td>
                      <td className="mono">{h.week ? fmtPercent(h.week.completion) : "—"}</td>
                      <td className="mono">{h.frozenMoney > 0 ? fmtMoney(h.frozenMoney) : "—"}</td>
                      <td className="risk-reasons">{h.reasons.length ? h.reasons.join("; ") : "—"}</td>
                      <td>
                        <span className={`status-pill ${RISK_CLASS[h.risk]}`}>{RISK_LABEL[h.risk]}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="cards">
              {visibleHealths.map((h) => (
                <div className="obj-card" key={h.object.id}>
                  <div className="row1">
                    <div>
                      <div className="cname">{h.object.name}</div>
                      <div className="caddr">
                        {fmtPercent(h.schedule.progressPlan)} план / {fmtPercent(h.schedule.progressFact)} факт
                      </div>
                    </div>
                    <span className={`status-pill ${RISK_CLASS[h.risk]}`}>{RISK_LABEL[h.risk]}</span>
                  </div>
                  <div className="cmeta">
                    <span>
                      График: {h.schedule.onTrack} в графике / {h.schedule.behind} отставание / {h.schedule.closed} закрыто
                    </span>
                    {h.week && <span>Неделя: {fmtPercent(h.week.completion)}</span>}
                    {h.frozenMoney > 0 && <span>Заморожено: {fmtMoney(h.frozenMoney)}</span>}
                  </div>
                  {h.reasons.length > 0 && <div className="risk-objects">{h.reasons.join("; ")}</div>}
                </div>
              ))}
            </div>
          </>
        )}
      </section>

      <section className="section-block">
        <h3 className="section-title">
          Очередь приёмки{" "}
          {visiblePendingFlat.length > 0 && (
            <span className="chip st-neutral">
              <span className="n">{visiblePendingFlat.length}</span>
            </span>
          )}
        </h3>
        {visiblePendingFlat.length === 0 ? (
          <p className="hint">Готовых этапов без подписанного акта нет.</p>
        ) : (
          <ul className="accept-list">
            {visiblePendingFlat.map((p) => {
              const overdue = (p.daysWaiting ?? 0) >= ACCEPTANCE_OVERDUE_DAYS;
              const isOpen = openAcceptTaskId === p.task.task.id;
              return (
                <li key={p.task.task.id} className="accept-item">
                  <div className="accept-row" onClick={() => (isOpen ? closeAccept() : openAccept(p))}>
                    <div className="accept-main">
                      <div className="accept-name">{p.task.task.name}</div>
                      <div className="accept-sub">{p.objectName}</div>
                    </div>
                    <div className="accept-meta">
                      <span className="mono">{fmtMoney(p.task.costTotal)}</span>
                      <span className={`chip ${overdue ? "st-bad" : "st-neutral"}`}>
                        {p.daysWaiting !== null
                          ? `${p.daysWaiting} ${plural(p.daysWaiting, "день", "дня", "дней")}`
                          : "срок неизвестен"}
                      </span>
                    </div>
                  </div>

                  {isOpen && (
                    <div className="accept-form">
                      <div className="field-row">
                        <div className="field">
                          <label>Статус</label>
                          <select
                            value={acceptForm.status}
                            onChange={(e) => setAcceptForm((f) => ({ ...f, status: e.target.value as AcceptanceStatus }))}
                          >
                            <option value="draft">Черновик</option>
                            <option value="review">На согласовании</option>
                            <option value="signed">Подписан</option>
                          </select>
                        </div>
                        <div className="field">
                          <label>№ акта</label>
                          <input
                            value={acceptForm.actNumber}
                            onChange={(e) => setAcceptForm((f) => ({ ...f, actNumber: e.target.value }))}
                          />
                        </div>
                      </div>
                      <div className="field-row">
                        <div className="field">
                          <label>Дата акта</label>
                          <input
                            type="date"
                            value={acceptForm.actDate}
                            onChange={(e) => setAcceptForm((f) => ({ ...f, actDate: e.target.value }))}
                          />
                        </div>
                        <div className="field">
                          <label>Сумма, ₽</label>
                          <input
                            type="number"
                            value={acceptForm.amount}
                            onChange={(e) => setAcceptForm((f) => ({ ...f, amount: e.target.value }))}
                          />
                        </div>
                      </div>
                      <div className="accept-actions">
                        <button className="btn btn-ghost btn-sm" onClick={closeAccept} disabled={acceptBusy}>
                          Отмена
                        </button>
                        <button className="btn btn-primary btn-sm" onClick={() => saveAccept(p)} disabled={acceptBusy}>
                          Сохранить
                        </button>
                        <button
                          className="btn btn-sm"
                          style={{ background: "var(--st-good-bg)", color: "var(--st-good-ink)" }}
                          onClick={() => markSigned(p)}
                          disabled={acceptBusy}
                        >
                          Отметить принятым
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="section-block">
        <h3 className="section-title">
          Выработка: план / факт / в актах{selectedObject ? ` — ${selectedObject.name}` : ""}
        </h3>
        {curve.length === 0 ? (
          <p className="hint">Недостаточно данных — нужны сроки и стоимости этапов графика.</p>
        ) : (
          <div className="curve-card">
            <svg viewBox="0 0 640 220" className="curve-svg" preserveAspectRatio="none">
              <line x1="20" y1="190" x2="620" y2="190" stroke="var(--border)" strokeWidth="1" />
              <path d={linePath((c) => c.plan)} fill="none" stroke="var(--muted)" strokeWidth="2" strokeDasharray="4 3" />
              <path d={linePath((c) => c.fact)} fill="none" stroke="var(--accent)" strokeWidth="2.5" />
              <path d={linePath((c) => c.acted)} fill="none" stroke="var(--st-good-ink)" strokeWidth="2" />
            </svg>
            <div className="curve-legend">
              <span>
                <i style={{ background: "var(--muted)" }} /> план
              </span>
              <span>
                <i style={{ background: "var(--accent)" }} /> факт (освоено)
              </span>
              <span>
                <i style={{ background: "var(--st-good-ink)" }} /> в актах
              </span>
            </div>
            <div className="curve-foot hint">
              На {fmtDate(curve[curve.length - 1]?.monthKey + "-01")}: факт {fmtMoney(curve[curve.length - 1]?.fact)}, в
              актах {fmtMoney(curve[curve.length - 1]?.acted)}, не в актах {fmtMoney(curve[curve.length - 1]?.notActed)}.
              Незакрытая выработка отнесена к текущему месяцу — точную хронологию система не хранит.
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

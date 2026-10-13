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
import { DOUBLE_TAP_HINT, useDoubleTap } from "@/lib/useDoubleTap";

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

interface FinValues {
  contract: number | null;
  plan: number | null;
  fact: number | null;
  workDone: number | null;
  forecast: number | null;
  overrun: number | null;
  saving: number | null;
  netDev: number | null;
  resultPlan: number | null;
  resultForecast: number | null;
  paid: number | null;
  cashGap: number | null;
}

/** Финансы объекта одним экраном: четыре группы по 2–4 цифры, переносятся по ширине — без прокрутки вбок. */
function FinBoard({ title, warnings, v, isTotal }: { title: string; warnings: string[]; v: FinValues; isTotal?: boolean }) {
  const money = (n: number | null) => (n === null ? "—" : fmtMoney(n));
  const row = (label: string, value: string, cls = "", hint?: string) => (
    <div className="fin-row" title={hint}>
      <span className="fin-l">{label}</span>
      <span className={`fin-v mono${cls}`}>{value}</span>
    </div>
  );
  return (
    <div className={`fin-board${isTotal ? " is-total" : ""}`}>
      <div className="fin-head">
        <div>
          <div className="fin-title">{title}</div>
          {warnings.length > 0 && <div className="fin-warn">{warnings.join("; ")}</div>}
        </div>
        <div className="fin-big" title="Договор − прогноз затрат: чем объект закончится при текущем раскладе">
          <span className="fin-l">Результат прогноз</span>
          <span className={`mono${signClass(v.resultForecast)}`}>{fmtSigned(v.resultForecast)}</span>
        </div>
      </div>
      <div className="fin-groups">
        <div className="fin-group">
          <div className="fin-gt">Себестоимость</div>
          {row("Смета", money(v.plan))}
          {row("Факт затрат", money(v.fact))}
          {row("Выполнено работ", money(v.workDone), "", "Стоимость работ графика × % готовности")}
          {row("Прогноз затрат", money(v.forecast))}
        </div>
        <div className="fin-group">
          <div className="fin-gt">Смета против факта</div>
          {row("Перерасход", v.overrun ? `−${fmtMoney(v.overrun)}` : "—", v.overrun ? " is-neg" : "", "Все красные статьи")}
          {row("Экономия", v.saving ? `+${fmtMoney(v.saving)}` : "—", v.saving ? " is-pos" : "", "Все зелёные статьи")}
          {row("Разница", fmtSigned(v.netDev), signClass(v.netDev), "Экономия − перерасход")}
        </div>
        <div className="fin-group">
          <div className="fin-gt">Результат объекта</div>
          {row("Договор", v.contract ? fmtMoney(v.contract) : "—")}
          {row("По смете", fmtSigned(v.resultPlan), signClass(v.resultPlan), "Договор − смета")}
          {row("Прогноз", fmtSigned(v.resultForecast), signClass(v.resultForecast), "Договор − прогноз затрат")}
        </div>
        <div className="fin-group">
          <div className="fin-gt">Деньги заказчика</div>
          {row("Получено", v.paid === null ? "не внесено" : fmtMoney(v.paid))}
          {row(
            v.cashGap !== null && v.cashGap > 0 ? "Вложено своих" : "Оплаты опережают затраты",
            v.cashGap === null ? "—" : fmtMoney(Math.abs(v.cashGap)),
            v.cashGap !== null && v.cashGap > 0 ? " is-neg" : "",
            "Факт затрат − получено от заказчика"
          )}
        </div>
      </div>
    </div>
  );
}

export default function PortfolioHealth() {
  const dbl = useDoubleTap();
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
  /** Выполнено работ в ₽ (стоимость × % готовности) по объекту — для сравнения с тратами. */
  const workDoneById = useMemo(() => {
    const m = new Map<string, number | null>();
    healths.forEach((h) => m.set(h.object.id, h.schedule.costDone));
    return m;
  }, [healths]);
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
      workDone: sum((f) => workDoneById.get(f.object.id) || 0),
      forecast: sum((f) => f.forecast),
      overrun: sum((f) => f.overrun),
      saving: sum((f) => f.saving),
      netDev: sum((f) => f.netDev),
      resultPlan: sum((f) => f.resultPlan || 0),
      resultForecast: sum((f) => f.resultForecast || 0),
      paid: sum((f) => f.paid),
      // Разрыв по деньгам — только по объектам, где оплаты внесены, иначе он равен всему факту.
      cashGap: sum((f) => (f.hasPayments ? f.cashGap : 0)),
      hasPayments: ready.some((f) => f.hasPayments),
    };
  }, [finances, workDoneById]);

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
            {visibleFinances.map((f) => (
              <FinBoard
                key={f.object.id}
                title={f.object.name}
                warnings={f.warnings}
                v={{
                  contract: f.contract,
                  plan: f.hasBudget ? f.plan : null,
                  fact: f.hasBudget ? f.fact : null,
                  workDone: workDoneById.get(f.object.id) ?? null,
                  forecast: f.hasBudget ? f.forecast : null,
                  overrun: f.hasBudget ? f.overrun : null,
                  saving: f.hasBudget ? f.saving : null,
                  netDev: f.hasBudget ? f.netDev : null,
                  resultPlan: f.resultPlan,
                  resultForecast: f.resultForecast,
                  paid: f.hasPayments ? f.paid : null,
                  cashGap: f.hasPayments ? f.cashGap : null,
                }}
              />
            ))}
            {!selectedObject && finances.length > 1 && (
              <FinBoard
                title="Итого по портфелю"
                warnings={[`${financeTotal.count} из ${finances.length} — объекты с договором и бюджетом`]}
                isTotal
                v={{
                  contract: financeTotal.contract,
                  plan: financeTotal.plan,
                  fact: financeTotal.fact,
                  workDone: financeTotal.workDone,
                  forecast: financeTotal.forecast,
                  overrun: financeTotal.overrun,
                  saving: financeTotal.saving,
                  netDev: financeTotal.netDev,
                  resultPlan: financeTotal.resultPlan,
                  resultForecast: financeTotal.resultForecast,
                  paid: financeTotal.hasPayments ? financeTotal.paid : null,
                  cashGap: financeTotal.hasPayments ? financeTotal.cashGap : null,
                }}
              />
            )}
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
                  {(() => {
                    const done = workDoneById.get(f.object.id);
                    if (done == null || !f.hasBudget) return null;
                    const gap = Math.round((f.fact - done) * 100) / 100;
                    return (
                      <>
                        {" "}
                        Выполнено работ на {fmtMoney(done)}, потрачено {fmtMoney(f.fact)}
                        {gap > 0 ? (
                          <>
                            {" "}— траты обгоняют работу на <span className="is-neg">{fmtMoney(gap)}</span> (часть может быть
                            авансами).
                          </>
                        ) : gap < 0 ? (
                          <> — работа обгоняет траты на {fmtMoney(-gap)}.</>
                        ) : (
                          "."
                        )}
                      </>
                    );
                  })()}
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
                  <div className="accept-row" onClick={dbl(p.task.task.id, () => (isOpen ? closeAccept() : openAccept(p)))} title={DOUBLE_TAP_HINT}>
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
                <i style={{ background: "var(--accent)" }} /> выполнено в ₽
              </span>
              <span>
                <i style={{ background: "var(--st-good-ink)" }} /> в актах
              </span>
            </div>
            <div className="curve-foot hint">
              На {fmtDate(curve[curve.length - 1]?.monthKey + "-01")}: выполнено в ₽ {fmtMoney(curve[curve.length - 1]?.fact)}, в
              актах {fmtMoney(curve[curve.length - 1]?.acted)}, не в актах {fmtMoney(curve[curve.length - 1]?.notActed)}.
              Незакрытая выработка отнесена к текущему месяцу — точную хронологию система не хранит.
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

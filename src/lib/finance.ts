import { BudgetLine, ConstructionObject, CustomerPayment, ScheduleTask } from "@/lib/types";
import { workCodeOf } from "@/lib/zeroCost";

/**
 * Финансы объекта для дашборда.
 *
 * Смета («Сметы и бюджет», план) — наша себестоимость; договор — выручка.
 * Результат = договор − затраты. Прогноз затрат честный: по закрытым работам —
 * их факт (экономия уже закреплена), по незакрытым — не меньше плана (их
 * «экономия» пока лишь неизрасходованный остаток). Накладные до завершения
 * объекта считаются по плану — их экономия/перерасход появляются только в конце.
 */
export interface ObjectFinance {
  object: ConstructionObject;
  hasBudget: boolean;
  contract: number | null;
  /** Себестоимость по смете. */
  plan: number;
  /** Фактически потрачено — все статьи, включая накладные. */
  fact: number;
  /** Прогноз себестоимости на завершение. */
  forecast: number;
  /** Договор − смета: с каким результатом объект взят. */
  resultPlan: number | null;
  /** Договор − прогноз: чем объект закончится при текущем раскладе. */
  resultForecast: number | null;
  /** Экономия (+) / перерасход (−) по закрытым работам — уже не изменится. */
  lockedSaving: number;
  /** Смета незакрытых работ и накладных, ещё не потраченная. */
  remainingPlan: number;
  /** Сколько нужно сэкономить на оставшемся, чтобы выйти в ноль. */
  toBreakEven: number;
  /** Получено от заказчика. */
  paid: number;
  hasPayments: boolean;
  /** Затраты − оплаты: плюс — объект кредитуем из своих. */
  cashGap: number;
  warnings: string[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Как статья бюджета входит в экономию/перерасход — одно правило для «Смет и бюджета» и дашборда.
 * - counted — входит: работа закрыта (или объект завершён), либо факт уже превысил смету —
 *   перерасход считается сразу, эти деньги уже потрачены;
 * - remainder — работа не закрыта, факт в пределах сметы: «план − факт» — неизрасходованный
 *   остаток, а не экономия; станет экономией или уйдёт в расход после закрытия;
 * - deferred — накладные до завершения объекта;
 * - missing — работа закрыта, а факт 0 ₽ без подтверждения;
 * - notStarted — факта ещё нет.
 */
export type LineKind = "counted" | "remainder" | "deferred" | "missing" | "notStarted";

export interface LineRules {
  isOverhead: (l: BudgetLine) => boolean;
  isClosed: (l: BudgetLine) => boolean;
  kind: (l: BudgetLine) => LineKind;
  /** План − факт по статье: минус — перерасход, плюс — экономия или остаток; null — факта нет. */
  dev: (l: BudgetLine) => number | null;
  /** Прогноз затрат по статье: по закрытой работе — её факт, по остальным — не меньше сметы. */
  forecast: (l: BudgetLine) => number;
}

/**
 * progress — % факт работ графика по шифру; names — названия работ и этапов по шифру
 * (накладные — статьи этапа, в названии которого есть «накладн»).
 */
export function makeLineRules(progress: Map<string, number>, names: Map<string, string>, objectDone: boolean): LineRules {
  const isOverhead = (l: BudgetLine): boolean => {
    const stage = workCodeOf(l.name)?.split(".")[0];
    return /накладн/i.test(stage ? names.get(stage) || "" : "") || /накладн/i.test(l.name);
  };
  const isClosed = (l: BudgetLine): boolean => {
    const code = workCodeOf(l.name);
    return code !== null && (progress.get(code) ?? -1) >= 100;
  };
  const kind = (l: BudgetLine): LineKind => {
    const p = Number(l.plan_amount) || 0;
    const f = Number(l.fact_amount) || 0;
    if (!objectDone && isOverhead(l)) return "deferred";
    if (objectDone || isClosed(l)) {
      if (f <= 0 && p > 0 && !l.zero_fact_confirmed) return "missing";
      return "counted";
    }
    if (f > p) return "counted";
    if (f > 0) return "remainder";
    return "notStarted";
  };
  const dev = (l: BudgetLine): number | null => {
    const p = Number(l.plan_amount) || 0;
    const f = Number(l.fact_amount) || 0;
    if (f > 0) return r2(p - f);
    return kind(l) === "counted" ? r2(p) : null;
  };
  const forecast = (l: BudgetLine): number => {
    const p = Number(l.plan_amount) || 0;
    const f = Number(l.fact_amount) || 0;
    if (kind(l) === "counted" && (objectDone || isClosed(l))) return f;
    return l.forecast_amount !== null && l.forecast_amount !== undefined ? Number(l.forecast_amount) : Math.max(p, f);
  };
  return { isOverhead, isClosed, kind, dev, forecast };
}

/** Прогресс и названия работ графика по шифру — вход для makeLineRules. */
export function scheduleMaps(tasks: Pick<ScheduleTask, "code" | "name" | "progress_fact">[]) {
  const progress = new Map<string, number>();
  const names = new Map<string, string>();
  tasks.forEach((t) => {
    if (!t.code) return;
    progress.set(t.code, Number(t.progress_fact) || 0);
    names.set(t.code, t.name);
  });
  return { progress, names };
}

export function computeObjectFinance(
  object: ConstructionObject,
  lines: BudgetLine[],
  tasks: ScheduleTask[],
  payments: CustomerPayment[]
): ObjectFinance {
  const done = object.status === "done";
  const { progress, names } = scheduleMaps(tasks);
  const rules = makeLineRules(progress, names, done);

  let plan = 0;
  let fact = 0;
  let forecast = 0;
  let lockedSaving = 0;
  let remainingPlan = 0;
  lines.forEach((l) => {
    const p = Number(l.plan_amount) || 0;
    const f = Number(l.fact_amount) || 0;
    plan += p;
    fact += f;
    const lf = rules.forecast(l);
    forecast += lf;
    // Факт закрытой работы окончателен: её экономия/перерасход уже не изменятся.
    if (rules.kind(l) === "counted" && (done || rules.isClosed(l))) lockedSaving += p - f;
    else remainingPlan += Math.max(0, lf - f);
  });

  const contract = object.contract_amount !== null && object.contract_amount !== undefined ? Number(object.contract_amount) : null;
  const hasBudget = lines.length > 0;
  const paid = payments.reduce((s, x) => s + (Number(x.amount) || 0), 0);
  const resultForecast = contract !== null && hasBudget ? r2(contract - forecast) : null;

  const warnings: string[] = [];
  if (contract === null || contract <= 0) warnings.push("сумма договора не указана");
  if (!hasBudget) warnings.push("бюджета нет");
  if (!payments.length) warnings.push("оплаты заказчика не внесены");

  return {
    object,
    hasBudget,
    contract,
    plan: r2(plan),
    fact: r2(fact),
    forecast: r2(forecast),
    resultPlan: contract !== null && hasBudget ? r2(contract - plan) : null,
    resultForecast,
    lockedSaving: r2(lockedSaving),
    remainingPlan: r2(remainingPlan),
    toBreakEven: resultForecast !== null && resultForecast < 0 ? r2(-resultForecast) : 0,
    paid: r2(paid),
    hasPayments: payments.length > 0,
    cashGap: r2(fact - paid),
    warnings,
  };
}

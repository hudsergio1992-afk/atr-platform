import { BudgetLine, ConstructionObject, CustomerPayment, ScheduleTask } from "@/lib/types";
import { budgetTaskLookup, workCodeOf } from "@/lib/zeroCost";
import { buildTree, flattenTree } from "@/lib/schedule";

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
  /** Перерасход — все красные статьи, как в «Сметах и бюджете» (положительное число). */
  overrun: number;
  /** Экономия — все зелёные статьи, как в «Сметах и бюджете». */
  saving: number;
  /** Разница: экономия − перерасход (плюс — экономия). */
  netDev: number;
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
  /** % готовности работы статьи по графику; null — шифра нет или работы нет в графике. */
  progress: (l: BudgetLine) => number | null;
}

export function makeLineRules(tasks: ScheduleTask[], objectDone: boolean): LineRules {
  const findTask = budgetTaskLookup(tasks);
  const today = new Date().toISOString().slice(0, 10);
  const nodes = new Map(flattenTree(buildTree(tasks, today)).map((node) => [node.task.id, node]));
  const namesByCode = new Map(tasks.map((task) => [task.code, task.name]));
  const progressOf = (line: BudgetLine): number | null => {
    const task = findTask(line);
    return task ? nodes.get(task.id)?.progressFact ?? null : null;
  };
  const isOverhead = (line: BudgetLine): boolean => {
    const task = findTask(line);
    const stageCode = (task?.code ?? workCodeOf(line.name))?.split(".")[0];
    return /накладн/i.test(namesByCode.get(stageCode ?? "") ?? "") ||
      /накладн/i.test(task?.name ?? "") || /накладн/i.test(line.name);
  };
  const isClosed = (line: BudgetLine): boolean => (progressOf(line) ?? -1) >= 100;
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
  return { isOverhead, isClosed, kind, dev, forecast, progress: progressOf };
}

export function computeObjectFinance(
  object: ConstructionObject,
  lines: BudgetLine[],
  tasks: ScheduleTask[],
  payments: CustomerPayment[]
): ObjectFinance {
  const done = object.status === "done";
  const rules = makeLineRules(tasks, done);

  let plan = 0;
  let fact = 0;
  let forecast = 0;
  let lockedSaving = 0;
  let remainingPlan = 0;
  let overrun = 0;
  let saving = 0;
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
    // Красные/зелёные статьи — то же правило, что в итогах «Смет и бюджета»: только учтённые
    // (закрытые работы и перерасход сразу); остаток, накладные и невнесённый факт — не входят.
    if (rules.kind(l) === "counted") {
      const d = rules.dev(l);
      if (d !== null && d < 0) overrun += -d;
      else if (d !== null) saving += d;
    }
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
    overrun: r2(overrun),
    saving: r2(saving),
    netDev: r2(r2(saving) - r2(overrun)),
    toBreakEven: resultForecast !== null && resultForecast < 0 ? r2(-resultForecast) : 0,
    paid: r2(paid),
    hasPayments: payments.length > 0,
    cashGap: r2(fact - paid),
    warnings,
  };
}

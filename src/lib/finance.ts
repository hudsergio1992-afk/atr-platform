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

export function computeObjectFinance(
  object: ConstructionObject,
  lines: BudgetLine[],
  tasks: ScheduleTask[],
  payments: CustomerPayment[]
): ObjectFinance {
  const done = object.status === "done";
  const progress = new Map<string, number>();
  const names = new Map<string, string>();
  tasks.forEach((t) => {
    if (!t.code) return;
    progress.set(t.code, Number(t.progress_fact) || 0);
    names.set(t.code, t.name);
  });

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
    const code = workCodeOf(l.name);
    const stage = code ? code.split(".")[0] : "";
    const overhead = /накладн/i.test(names.get(stage) || "") || /накладн/i.test(l.name);
    const closed = code !== null && (progress.get(code) ?? -1) >= 100;
    // Факт по закрытой работе окончателен, если он внесён или ноль подтверждён.
    const factFinal = f > 0 || !!l.zero_fact_confirmed || p <= 0;
    if (done || (closed && !overhead && factFinal)) {
      forecast += f;
      lockedSaving += p - f;
    } else {
      const lf = l.forecast_amount !== null && l.forecast_amount !== undefined ? Number(l.forecast_amount) : Math.max(p, f);
      forecast += lf;
      remainingPlan += Math.max(0, lf - f);
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
    toBreakEven: resultForecast !== null && resultForecast < 0 ? r2(-resultForecast) : 0,
    paid: r2(paid),
    hasPayments: payments.length > 0,
    cashGap: r2(fact - paid),
    warnings,
  };
}

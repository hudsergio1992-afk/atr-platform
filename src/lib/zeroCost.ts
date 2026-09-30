import { supabase } from "@/lib/supabaseClient";

/**
 * Закрытие работы «нулём»: на работу заложены деньги, а по её статьям бюджета
 * не потрачено ни рубля. Так бывает законно (давальческий материал), но чаще —
 * это незаполненный факт, поэтому закрыть такую работу можно только с комментарием.
 */

export interface CostByWork {
  plan: number;
  fact: number;
}

/** Шифр работы в начале названия статьи бюджета: «4.6 Армирование … — Арматура». */
export function workCodeOf(name: string): string | null {
  return /^(\d+(?:\.\d+)*)\s/.exec(name)?.[1] ?? null;
}

/** План и факт статей бюджета объекта, сложенные по шифру работы. */
export async function loadCostByWork(objectId: string): Promise<Map<string, CostByWork>> {
  const out = new Map<string, CostByWork>();
  if (!objectId) return out;
  const { data, error } = await supabase
    .from("budget_lines")
    .select("name,plan_amount,fact_amount")
    .eq("object_id", objectId);
  // Бюджета нет или он недоступен — правило просто не действует.
  if (error || !data) return out;
  (data as { name: string; plan_amount: number; fact_amount: number }[]).forEach((l) => {
    const code = workCodeOf(l.name);
    if (!code) return;
    const cur = out.get(code) || { plan: 0, fact: 0 };
    cur.plan += Number(l.plan_amount) || 0;
    cur.fact += Number(l.fact_amount) || 0;
    out.set(code, cur);
  });
  return out;
}

/**
 * Сколько заложено на работу, если закрыть её можно только с комментарием; иначе null.
 * Правило действует, только когда у работы есть статьи бюджета: без них факт неизвестен,
 * а не равен нулю.
 */
export function zeroCostPlan(
  code: string | null,
  costTotal: number | null,
  costs: Map<string, CostByWork>
): number | null {
  const c = code ? costs.get(code) : undefined;
  if (!c) return null;
  const plan = Math.max(c.plan, Number(costTotal) || 0);
  return plan > 0 && c.fact <= 0 ? Math.round(plan * 100) / 100 : null;
}

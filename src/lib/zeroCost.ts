import { supabase } from "@/lib/supabaseClient";

/**
 * Фактическая стоимость работы ставится при её закрытии.
 *
 * Факт затрат живёт в «Сметах и бюджете»: статьи привязаны к работе шифром
 * в начале названия. Закрыть работу можно, только когда её факт внесён; если
 * затрат действительно не было (давальческий материал) — с комментарием.
 */

export interface WorkBudgetLine {
  id: string;
  name: string;
  plan_amount: number;
  fact_amount: number;
  history: { at: string; text: string }[];
}

export interface CostByWork {
  plan: number;
  fact: number;
  lines: WorkBudgetLine[];
}

/** Шифр работы в начале названия статьи бюджета: «4.6 Армирование … — Арматура». */
export function workCodeOf(name: string): string | null {
  return /^(\d+(?:\.\d+)*)\s/.exec(name)?.[1] ?? null;
}

/**
 * Статьи бюджета объекта, сгруппированные по шифру работы, с суммами плана и факта.
 * Статьи без шифра — под ключом "" (чтобы общий факт затрат был полным).
 */
export async function loadCostByWork(objectId: string): Promise<Map<string, CostByWork>> {
  const out = new Map<string, CostByWork>();
  if (!objectId) return out;
  const { data, error } = await supabase
    .from("budget_lines")
    .select("id,name,plan_amount,fact_amount,history")
    .eq("object_id", objectId)
    .order("name");
  // Бюджета нет или он недоступен — считаем, что статей у работ нет.
  if (error || !data) return out;
  (data as WorkBudgetLine[]).forEach((l) => {
    const code = workCodeOf(l.name) ?? "";
    const cur = out.get(code) || { plan: 0, fact: 0, lines: [] };
    cur.plan += Number(l.plan_amount) || 0;
    cur.fact += Number(l.fact_amount) || 0;
    cur.lines.push(l);
    out.set(code, cur);
  });
  return out;
}

/** Внесён ли факт затрат по работе: есть статьи и по ним потрачено больше нуля. */
export function workFactEntered(code: string | null, costs: Map<string, CostByWork>): boolean {
  const c = code ? costs.get(code) : undefined;
  return !!c && c.fact > 0;
}

/**
 * Потрачено по бюджету на работу или этап: статьи с этим шифром и шифрами вложенных работ
 * («4» — это 4, 4.1, 4.6 …). Без шифра — весь факт объекта, null — если статей нет.
 */
export function spentByCode(code: string | null, costs: Map<string, CostByWork>): number | null {
  let sum = 0;
  let found = false;
  costs.forEach((c, k) => {
    if (code === null || k === code || k.startsWith(code + ".")) {
      sum += c.fact;
      found = true;
    }
  });
  return found ? Math.round(sum * 100) / 100 : null;
}

/** Название статьи, которая заводится при закрытии работы без статей бюджета. */
export function closingLineName(code: string | null, workName: string): string {
  return `${code ? code + " " : ""}${workName} — факт при закрытии`;
}

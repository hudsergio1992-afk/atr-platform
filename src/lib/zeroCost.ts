import { supabase } from "@/lib/supabaseClient";
import type { BudgetLine, ScheduleTask } from "@/lib/types";

export type WorkBudgetLine = Pick<
  BudgetLine,
  "id" | "name" | "task_id" | "plan_amount" | "fact_amount" | "zero_fact_confirmed" | "history"
>;

export interface CostByWork {
  plan: number;
  fact: number;
  lines: WorkBudgetLine[];
}

/** Шифр старой статьи бюджета: «4.6 Армирование … — Арматура». */
export function workCodeOf(name: string): string | null {
  return /^(\d+(?:\.\d+)*)\s/.exec(name)?.[1] ?? null;
}

/** Старая статья без прямой привязки по-прежнему находится по шифру. */
export function budgetTaskLookup(tasks: ScheduleTask[]) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const byCode = new Map<string, ScheduleTask>();
  for (const task of tasks) {
    if (task.code) byCode.set(task.code, task);
  }

  return (line: Pick<BudgetLine, "name" | "task_id">): ScheduleTask | undefined => {
    if (line.task_id) return byId.get(line.task_id);
    let code = workCodeOf(line.name);
    while (code) {
      const task = byCode.get(code);
      if (task) return task;
      const separator = code.lastIndexOf(".");
      code = separator < 0 ? null : code.slice(0, separator);
    }
    return undefined;
  };
}

export async function loadWorkBudgetLines(objectId: string) {
  return supabase
    .from("budget_lines")
    .select("id,name,task_id,plan_amount,fact_amount,zero_fact_confirmed,history")
    .eq("object_id", objectId)
    .order("name");
}

/** Пустой ключ — статьи объекта без работы. */
export function groupWorkCosts(tasks: ScheduleTask[], lines: WorkBudgetLine[]): Map<string, CostByWork> {
  const findTask = budgetTaskLookup(tasks);
  const costs = new Map<string, CostByWork>();
  for (const line of lines) {
    const key = findTask(line)?.id ?? "";
    const current = costs.get(key) ?? { plan: 0, fact: 0, lines: [] };
    current.plan += Number(line.plan_amount) || 0;
    current.fact += Number(line.fact_amount) || 0;
    current.lines.push(line);
    costs.set(key, current);
  }
  return costs;
}

export function workFactEntered(taskId: string, costs: Map<string, CostByWork>): boolean {
  const cost = costs.get(taskId);
  return !!cost?.lines.length &&
    (cost.fact > 0 || cost.lines.every((line) => Number(line.fact_amount) > 0 || !!line.zero_fact_confirmed));
}

/** Название статьи, которая заводится при закрытии работы без статей бюджета. */
export function closingLineName(code: string | null, workName: string): string {
  return `${code ? code + " " : ""}${workName} — факт при закрытии`;
}

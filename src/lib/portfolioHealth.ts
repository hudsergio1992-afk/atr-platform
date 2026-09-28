/**
 * Расчёты для дашборда портфеля: карта здоровья объектов, топ причин риска,
 * очередь приёмки с зависшими деньгами и S-кривая выработки.
 *
 * Ничего не хранится отдельно — всё производное от графика (schedule.ts),
 * недельных заданий (weekly.ts) и актов приёмки (acceptance_acts). Модули
 * «Снабжение» и «Сметы» в базе ещё не существуют, поэтому причины риска,
 * завязанные на них («материалы без заявки», «нет ответственного»),
 * сюда сознательно не включены — считать их не из чего.
 */

import {
  AcceptanceAct,
  ConstructionObject,
  ScheduleTask,
  WeeklyItem,
} from "@/lib/types";
import { buildTree, flattenTree, parseDay, summarize, ScheduleSummary, TaskNode } from "@/lib/schedule";
import { summarizeWeek, WeeklySummary } from "@/lib/weekly";
import { plural } from "@/lib/format";

const MS_PER_DAY = 86_400_000;

/** Дней без обновления факта по открытой работе, после чего это «стройка стоит». */
export const STALL_DAYS = 10;
/** Дней в очереди на приёмку, после чего готовый этап считается зависшим. */
export const ACCEPTANCE_OVERDUE_DAYS = 7;
/** Недельное выполнение ниже этого порога — повод для внимания. */
export const WEEK_COMPLETION_WARN = 70;

export type RiskLevel = "critical" | "warning" | "ok";

export const RISK_LABEL: Record<RiskLevel, string> = {
  critical: "Критично",
  warning: "Внимание",
  ok: "В норме",
};

export const RISK_CLASS: Record<RiskLevel, string> = {
  critical: "st-bad",
  warning: "st-warn",
  ok: "st-good",
};

export interface PendingAcceptance {
  task: TaskNode;
  /** Дней с фактического (или планового, если факта нет) окончания этапа. null — дата неизвестна. */
  daysWaiting: number | null;
}

export interface ObjectHealth {
  object: ConstructionObject;
  schedule: ScheduleSummary;
  week: WeeklySummary | null;
  /** Дней с последнего изменения факта по ещё не закрытой работе. null — открытых работ нет. */
  stallDays: number | null;
  pendingAcceptance: PendingAcceptance[];
  /** Сумма по этапам, готовым на площадке, но без подписанного акта, ₽. */
  frozenMoney: number;
  risk: RiskLevel;
  /** Короткие причины риска именно по этому объекту, для карточки/строки. */
  reasons: string[];
}

function daysBetween(from: string | null, to: string | null): number | null {
  const a = parseDay(from);
  const b = parseDay(to);
  if (a === null || b === null) return null;
  return Math.round((b - a) / MS_PER_DAY);
}

export function computeObjectHealth(
  object: ConstructionObject,
  tasks: ScheduleTask[],
  weekItems: WeeklyItem[] | null,
  acts: AcceptanceAct[],
  today: string
): ObjectHealth {
  const tree = buildTree(tasks, today);
  const schedule = summarize(tree);
  const week = weekItems && weekItems.length ? summarizeWeek(weekItems) : null;
  const leaves = flattenTree(tree).filter((n) => !n.isGroup);

  // «Стройка стоит»: среди ещё не закрытых работ — давность самого свежего обновления.
  const openLeaves = leaves.filter((n) => n.status !== "closed");
  let stallDays: number | null = null;
  if (openLeaves.length) {
    const mostRecent = openLeaves.reduce(
      (latest, n) => (n.task.updated_at > latest ? n.task.updated_at : latest),
      ""
    );
    if (mostRecent) {
      const d = daysBetween(mostRecent.slice(0, 10), today);
      stallDays = d !== null && d > 0 ? d : 0;
    }
  }

  const signedTaskIds = new Set(acts.filter((a) => a.status === "signed").map((a) => a.task_id));
  const pendingAcceptance: PendingAcceptance[] = leaves
    .filter((n) => n.progressFact >= 100 && !signedTaskIds.has(n.task.id))
    .map((n) => ({
      task: n,
      daysWaiting: daysBetween(n.endFact || n.endPlan, today),
    }))
    .sort((a, b) => (b.daysWaiting ?? -1) - (a.daysWaiting ?? -1));

  const frozenMoney =
    Math.round(pendingAcceptance.reduce((s, p) => s + (p.task.costTotal || 0), 0) * 100) / 100;

  const overdueAcceptance = pendingAcceptance.filter((p) => (p.daysWaiting ?? 0) >= ACCEPTANCE_OVERDUE_DAYS);

  const reasons: string[] = [];
  if (stallDays !== null && stallDays >= STALL_DAYS) {
    reasons.push(`факт не обновляется ${stallDays} ${plural(stallDays, "день", "дня", "дней")}`);
  }
  if (schedule.behind > 0) {
    reasons.push(`${schedule.behind} ${plural(schedule.behind, "этап", "этапа", "этапов")} в отставании`);
  }
  if (overdueAcceptance.length) {
    reasons.push(
      `${overdueAcceptance.length} ${plural(overdueAcceptance.length, "этап", "этапа", "этапов")} без акта дольше ${ACCEPTANCE_OVERDUE_DAYS} дней`
    );
  }
  if (week && week.total > 0 && week.completion !== null && week.completion < WEEK_COMPLETION_WARN) {
    reasons.push(`неделя выполнена на ${Math.round(week.completion)}%`);
  }

  let risk: RiskLevel = "ok";
  if ((stallDays !== null && stallDays >= STALL_DAYS) || schedule.behind >= 3 || overdueAcceptance.length >= 2) {
    risk = "critical";
  } else if (
    schedule.behind > 0 ||
    overdueAcceptance.length > 0 ||
    (week && week.total > 0 && week.completion !== null && week.completion < WEEK_COMPLETION_WARN)
  ) {
    risk = "warning";
  }

  return { object, schedule, week, stallDays, pendingAcceptance, frozenMoney, risk, reasons };
}

export interface TopRisk {
  text: string;
  count: number;
  objects: string[];
}

/** Ранжированный список системных причин риска по всему портфелю. */
export function computeTopRisks(healths: ObjectHealth[]): TopRisk[] {
  const stalled = healths.filter((h) => h.stallDays !== null && h.stallDays >= STALL_DAYS);
  const behind = healths.filter((h) => h.schedule.behind > 0);
  const overdueAcceptance = healths.filter((h) =>
    h.pendingAcceptance.some((p) => (p.daysWaiting ?? 0) >= ACCEPTANCE_OVERDUE_DAYS)
  );
  const weakWeek = healths.filter(
    (h) => h.week && h.week.total > 0 && h.week.completion !== null && h.week.completion < WEEK_COMPLETION_WARN
  );

  const risks: TopRisk[] = [];
  if (stalled.length) {
    risks.push({
      text: `Стройка стоит — факт не обновлялся ${STALL_DAYS}+ дней`,
      count: stalled.length,
      objects: stalled.map((h) => h.object.name),
    });
  }
  if (behind.length) {
    const totalTasks = behind.reduce((s, h) => s + h.schedule.behind, 0);
    risks.push({
      text: `Отставание графика — ${totalTasks} ${plural(totalTasks, "этап", "этапа", "этапов")} на ${behind.length} ${plural(behind.length, "объекте", "объектах", "объектах")}`,
      count: behind.length,
      objects: behind.map((h) => h.object.name),
    });
  }
  if (overdueAcceptance.length) {
    const totalTasks = overdueAcceptance.reduce(
      (s, h) => s + h.pendingAcceptance.filter((p) => (p.daysWaiting ?? 0) >= ACCEPTANCE_OVERDUE_DAYS).length,
      0
    );
    risks.push({
      text: `Приёмка зависла — ${totalTasks} ${plural(totalTasks, "этап", "этапа", "этапов")} готовы, акт не подписан ${ACCEPTANCE_OVERDUE_DAYS}+ дней`,
      count: overdueAcceptance.length,
      objects: overdueAcceptance.map((h) => h.object.name),
    });
  }
  if (weakWeek.length) {
    risks.push({
      text: `Недельные задания не выполняются — факт ниже ${WEEK_COMPLETION_WARN}% плана`,
      count: weakWeek.length,
      objects: weakWeek.map((h) => h.object.name),
    });
  }
  return risks.sort((a, b) => b.count - a.count);
}

export interface CurvePoint {
  monthKey: string;
  label: string;
  /** Накопленная плановая стоимость по срокам графика, ₽. */
  plan: number;
  /** Накопленная выработка факт, ₽ — освоение по проценту готовности. */
  fact: number;
  /** Накопленная сумма по подписанным актам, ₽. */
  acted: number;
  /** Выработка, ещё не подтверждённая актом: fact − acted, ₽. */
  notActed: number;
}

const MONTHS_GEN = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

function monthKeyOf(iso: string): string {
  return iso.slice(0, 7);
}

function monthLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return `${MONTHS_GEN[(m || 1) - 1]} ${y}`;
}

/**
 * S-кривая портфеля: план — по срокам графика, факт — по проценту готовности
 * (незакрытая выработка, для которой нет даты события, лумпится в текущий
 * месяц — точной хронологии освоения система не хранит), в актах — по датам
 * подписанных актов.
 */
export function computeProductionCurve(
  objects: ConstructionObject[],
  tasksByObject: Map<string, ScheduleTask[]>,
  actsByObject: Map<string, AcceptanceAct[]>,
  today: string
): CurvePoint[] {
  const currentMonthKey = monthKeyOf(today);
  const planByMonth = new Map<string, number>();
  const factByMonth = new Map<string, number>();
  const actedByMonth = new Map<string, number>();

  for (const obj of objects) {
    const tasks = tasksByObject.get(obj.id) || [];
    if (!tasks.length) continue;
    const leaves = flattenTree(buildTree(tasks, today)).filter((n) => !n.isGroup);
    for (const n of leaves) {
      if (n.costTotal === null) continue;
      if (n.endPlan) {
        const k = monthKeyOf(n.endPlan);
        planByMonth.set(k, (planByMonth.get(k) || 0) + n.costTotal);
      }
      if (n.progressFact >= 100 && n.endFact) {
        const k = monthKeyOf(n.endFact);
        factByMonth.set(k, (factByMonth.get(k) || 0) + n.costTotal);
      } else if (n.costDone) {
        factByMonth.set(currentMonthKey, (factByMonth.get(currentMonthKey) || 0) + n.costDone);
      }
    }

    for (const a of actsByObject.get(obj.id) || []) {
      if (a.status !== "signed" || !a.act_date || a.amount === null) continue;
      const k = monthKeyOf(a.act_date);
      actedByMonth.set(k, (actedByMonth.get(k) || 0) + a.amount);
    }
  }

  const allKeys = new Set<string>([...planByMonth.keys(), ...factByMonth.keys(), ...actedByMonth.keys()]);
  const sortedKeys = Array.from(allKeys).sort();
  if (!sortedKeys.length) return [];

  let cumPlan = 0;
  let cumFact = 0;
  let cumActed = 0;
  return sortedKeys.map((k) => {
    cumPlan += planByMonth.get(k) || 0;
    cumFact += factByMonth.get(k) || 0;
    cumActed += actedByMonth.get(k) || 0;
    return {
      monthKey: k,
      label: monthLabel(k),
      plan: Math.round(cumPlan),
      fact: Math.round(cumFact),
      acted: Math.round(cumActed),
      notActed: Math.max(0, Math.round(cumFact - cumActed)),
    };
  });
}

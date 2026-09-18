import { ScheduleStatus, ScheduleTask, TaskKind, TrackingMode } from "@/lib/types";

/**
 * Допуск отклонения план-факт в процентных пунктах: пока факт отстаёт
 * от плана не больше чем на эту величину, этап считается идущим в графике.
 */
export const LAG_TOLERANCE = 5;

const MS_PER_DAY = 86_400_000;

/** "YYYY-MM-DD" -> миллисекунды UTC-полуночи. null при пустом/битом значении. */
export function parseDay(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(t) ? null : t;
}

/** Миллисекунды UTC-полуночи -> "YYYY-MM-DD". */
export function dayToISO(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/** Сегодняшняя дата по локальному календарю пользователя, в виде "YYYY-MM-DD". */
export function todayISO(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Календарных дней включительно: 01.03–01.03 = 1 день. */
export function daysInclusive(from: string | null, to: string | null): number | null {
  const a = parseDay(from);
  const b = parseDay(to);
  if (a === null || b === null) return null;
  const n = Math.round((b - a) / MS_PER_DAY) + 1;
  return n > 0 ? n : null;
}

export function clampPercent(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return Math.round(n * 10) / 10;
}

/**
 * % готовности план — доля прошедшего времени от плановой длительности:
 * до начала 0, после окончания 100.
 */
export function planProgress(
  startPlan: string | null,
  endPlan: string | null,
  today: string
): number | null {
  const a = parseDay(startPlan);
  const b = parseDay(endPlan);
  const t = parseDay(today);
  if (a === null || b === null || t === null) return null;
  if (b <= a) return t >= b ? 100 : 0;
  return clampPercent(((t - a) / (b - a)) * 100);
}

/** Узел дерева графика: сама запись + производные показатели (у групп — свёрнутые с детей). */
export interface TaskNode {
  task: ScheduleTask;
  children: TaskNode[];
  /** Глубина вложенности, корень = 0. */
  level: number;
  /** true, если у этапа есть подэтапы: его показатели агрегированы. */
  isGroup: boolean;
  startPlan: string | null;
  endPlan: string | null;
  startFact: string | null;
  endFact: string | null;
  durationPlan: number | null;
  /** Способ учёта выполнения; у группы — 'volume', только если так учитываются все дети. */
  tracking: TrackingMode;
  /** По графику или непредвиденная; у группы — 'extra', если непредвиденны все дети. */
  kind: TaskKind;
  /** Общий натуральный объём; у группы — сумма, только если единица у детей одна. */
  volumeTotal: number | null;
  unit: string | null;
  progressPlan: number | null;
  progressFact: number;
  /** факт − план в процентных пунктах; null, если план не считается. */
  deviation: number | null;
  status: ScheduleStatus;
  /** Вес узла при усреднении процентов у родителя — плановая длительность. */
  weight: number;
}

function minDay(values: (string | null)[]): string | null {
  let best: number | null = null;
  for (const v of values) {
    const d = parseDay(v);
    if (d !== null && (best === null || d < best)) best = d;
  }
  return best === null ? null : dayToISO(best);
}

function maxDay(values: (string | null)[]): string | null {
  let best: number | null = null;
  for (const v of values) {
    const d = parseDay(v);
    if (d !== null && (best === null || d > best)) best = d;
  }
  return best === null ? null : dayToISO(best);
}

function computeStatus(
  progressFact: number,
  deviation: number | null,
  endPlan: string | null,
  today: string
): ScheduleStatus {
  if (progressFact >= 100) return "closed";
  const end = parseDay(endPlan);
  const now = parseDay(today);
  // Плановый срок прошёл, а работа не закрыта — отставание независимо от процентов.
  if (end !== null && now !== null && now > end) return "behind";
  if (deviation !== null && deviation < -LAG_TOLERANCE) return "behind";
  return "on_track";
}

/**
 * Собирает дерево этапов и считает производные показатели снизу вверх.
 * У этапа с подэтапами собственные даты/НЧ/проценты игнорируются — берётся свёртка детей.
 * Записи с недостижимым parent_id (или в цикле) поднимаются в корень, чтобы не пропасть из графика.
 */
export function buildTree(tasks: ScheduleTask[], today: string): TaskNode[] {
  const byId = new Map<string, ScheduleTask>();
  tasks.forEach((t) => byId.set(t.id, t));

  const childrenOf = new Map<string, ScheduleTask[]>();
  const roots: ScheduleTask[] = [];

  for (const t of tasks) {
    // Поиск корня по цепочке родителей: обрывается на сироте и на цикле.
    let parentId: string | null = t.parent_id;
    if (parentId === t.id) parentId = null;
    if (parentId !== null) {
      const seen = new Set<string>([t.id]);
      let cur: string | null = parentId;
      while (cur !== null) {
        if (seen.has(cur)) {
          parentId = null;
          break;
        }
        seen.add(cur);
        const p: ScheduleTask | undefined = byId.get(cur);
        if (!p) {
          parentId = null;
          break;
        }
        cur = p.parent_id;
      }
    }
    if (parentId === null) {
      roots.push(t);
    } else {
      const list = childrenOf.get(parentId);
      if (list) list.push(t);
      else childrenOf.set(parentId, [t]);
    }
  }

  const bySort = (a: ScheduleTask, b: ScheduleTask) =>
    a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at);

  const build = (task: ScheduleTask, level: number): TaskNode => {
    const kids = (childrenOf.get(task.id) || []).slice().sort(bySort);
    const children = kids.map((k) => build(k, level + 1));

    if (children.length === 0) {
      const startPlan = task.start_plan;
      const endPlan = task.end_plan;
      const durationPlan = daysInclusive(startPlan, endPlan);
      const progressPlan = planProgress(startPlan, endPlan, today);
      const progressFact = clampPercent(Number(task.progress_fact) || 0);
      const deviation =
        progressPlan === null ? null : Math.round((progressFact - progressPlan) * 10) / 10;
      const volumeTotal =
        task.volume_total === null || task.volume_total === undefined
          ? null
          : Number(task.volume_total);
      return {
        task,
        children,
        level,
        isGroup: false,
        startPlan,
        endPlan,
        startFact: task.start_fact,
        endFact: task.end_fact,
        durationPlan,
        tracking: task.tracking === "volume" ? "volume" : "percent",
        kind: task.kind === "extra" ? "extra" : "plan",
        volumeTotal: volumeTotal !== null && Number.isFinite(volumeTotal) ? volumeTotal : null,
        unit: task.unit || null,
        progressPlan,
        progressFact,
        deviation,
        status: computeStatus(progressFact, deviation, endPlan, today),
        weight: durationPlan || 1,
      };
    }

    const startPlan = minDay(children.map((c) => c.startPlan));
    const endPlan = maxDay(children.map((c) => c.endPlan));
    const startFact = minDay(children.map((c) => c.startFact));
    // Дата факт. окончания группы имеет смысл, только когда закрыты все подэтапы.
    const allKidsFinished = children.every((c) => c.endFact);
    const endFact = allKidsFinished ? maxDay(children.map((c) => c.endFact)) : null;

    // Объёмы складываются, только когда у всех подэтапов с объёмом одна единица:
    // «120 м³ + 8 т» — бессмыслица, которую нельзя показывать как число.
    const withVolume = children.filter((c) => c.tracking === "volume" && c.volumeTotal !== null);
    const units = new Set(withVolume.map((c) => c.unit || ""));
    const sameUnit = withVolume.length > 0 && units.size === 1;
    const volumeTotal = sameUnit
      ? withVolume.reduce((s, c) => s + (c.volumeTotal || 0), 0)
      : null;
    const unit = sameUnit ? withVolume[0].unit : null;

    const totalWeight = children.reduce((s, c) => s + c.weight, 0) || children.length;
    const wAvg = (pick: (c: TaskNode) => number | null): number | null => {
      let sum = 0;
      let used = 0;
      for (const c of children) {
        const v = pick(c);
        if (v === null) continue;
        sum += v * c.weight;
        used += c.weight;
      }
      if (used === 0) return null;
      // Дети без планового процента не размывают среднее: усредняем по учтённому весу.
      return clampPercent(sum / used);
    };

    const progressPlan = wAvg((c) => c.progressPlan);
    const progressFact = wAvg((c) => c.progressFact) ?? 0;
    const deviation =
      progressPlan === null ? null : Math.round((progressFact - progressPlan) * 10) / 10;

    return {
      task,
      children,
      level,
      isGroup: true,
      startPlan,
      endPlan,
      startFact,
      endFact,
      durationPlan: daysInclusive(startPlan, endPlan),
      // Объём группы имеет смысл, только когда по объёму учитываются все подэтапы.
      tracking:
        children.length > 0 && children.every((c) => c.tracking === "volume")
          ? "volume"
          : "percent",
      // Раздел считается непредвиденным, только когда непредвиденны все его работы:
      // иначе плановый раздел с одной допработой выглядел бы целиком внеплановым.
      kind:
        task.kind === "extra" || (children.length > 0 && children.every((c) => c.kind === "extra"))
          ? "extra"
          : "plan",
      volumeTotal,
      unit,
      progressPlan,
      progressFact,
      deviation,
      status: computeStatus(progressFact, deviation, endPlan, today),
      weight: totalWeight,
    };
  };

  return roots.sort(bySort).map((t) => build(t, 0));
}

/** Разворачивает дерево в плоский список в порядке обхода сверху вниз. */
export function flattenTree(nodes: TaskNode[]): TaskNode[] {
  const out: TaskNode[] = [];
  const walk = (list: TaskNode[]) => {
    for (const n of list) {
      out.push(n);
      if (n.children.length) walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

/** Сводка по объекту: считается по листьям, чтобы группы не удваивали вклад. */
export interface ScheduleSummary {
  total: number;
  onTrack: number;
  behind: number;
  closed: number;
  /** Сколько работ вскрылось по ходу стройки. */
  extra: number;
  progressPlan: number | null;
  progressFact: number | null;
  startPlan: string | null;
  endPlan: string | null;
}

export function summarize(nodes: TaskNode[]): ScheduleSummary {
  const all = flattenTree(nodes);
  const leaves = all.filter((n) => !n.isGroup);
  const base = leaves.length ? leaves : all;

  let onTrack = 0;
  let behind = 0;
  let closed = 0;
  let extra = 0;
  for (const n of all) {
    if (n.status === "behind") behind++;
    else if (n.status === "closed") closed++;
    else onTrack++;
    if (n.kind === "extra") extra++;
  }

  const wSum = (pick: (n: TaskNode) => number | null): number | null => {
    let sum = 0;
    let used = 0;
    for (const n of base) {
      const v = pick(n);
      if (v === null) continue;
      sum += v * n.weight;
      used += n.weight;
    }
    return used === 0 ? null : clampPercent(sum / used);
  };

  return {
    total: all.length,
    onTrack,
    behind,
    closed,
    extra,
    progressPlan: wSum((n) => n.progressPlan),
    progressFact: wSum((n) => n.progressFact),
    startPlan: minDay(all.map((n) => n.startPlan)),
    endPlan: maxDay(all.map((n) => n.endPlan)),
  };
}

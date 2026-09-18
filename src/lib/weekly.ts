import { WeeklyItem } from "@/lib/types";
import { clampPercent, dayToISO, parseDay, planProgress, TaskNode } from "@/lib/schedule";

const MS_PER_DAY = 86_400_000;

/** Единицы, которые не делятся: «1,924 силоса» — бессмыслица, нужен целый. */
const WHOLE_UNITS = new Set(["шт", "компл.", "к-т", "шт.", "комплект"]);

/** Округление объёма под его единицу: штучное — вниз до целого, остальное — до грамма. */
function roundVolume(value: number, unit: string | null): number {
  if (unit && WHOLE_UNITS.has(unit.trim().toLowerCase())) return Math.floor(value);
  return Math.round(value * 1000) / 1000;
}

const MONTHS_GEN = [
  "янв", "фев", "мар", "апр", "мая", "июн",
  "июл", "авг", "сен", "окт", "ноя", "дек",
];

/** Понедельник той недели, в которую попадает дата. */
export function mondayOf(iso: string): string {
  const d = parseDay(iso);
  if (d === null) return iso;
  // getUTCDay(): 0 — воскресенье, поэтому сдвигаем на понедельник как начало недели.
  const shift = (new Date(d).getUTCDay() + 6) % 7;
  return dayToISO(d - shift * MS_PER_DAY);
}

/** Воскресенье недели, начинающейся с этого понедельника. */
export function weekEndOf(mondayISO: string): string {
  const d = parseDay(mondayISO);
  if (d === null) return mondayISO;
  return dayToISO(d + 6 * MS_PER_DAY);
}

export function shiftWeeks(mondayISO: string, weeks: number): string {
  const d = parseDay(mondayISO);
  if (d === null) return mondayISO;
  return dayToISO(d + weeks * 7 * MS_PER_DAY);
}

/** Номер недели по ISO 8601. */
export function isoWeekNumber(iso: string): number | null {
  const d = parseDay(iso);
  if (d === null) return null;
  const date = new Date(d);
  // Четверг той же недели определяет, какому году неделя принадлежит.
  const thursday = new Date(d + (3 - ((date.getUTCDay() + 6) % 7)) * MS_PER_DAY);
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  return Math.floor((thursday.getTime() - yearStart) / (7 * MS_PER_DAY)) + 1;
}

/** «22–28 сен 2026» либо «28 сен – 4 окт 2026», если неделя на стыке месяцев. */
export function weekLabel(mondayISO: string): string {
  const a = parseDay(mondayISO);
  const b = parseDay(weekEndOf(mondayISO));
  if (a === null || b === null) return mondayISO;
  const da = new Date(a);
  const db = new Date(b);
  const year = db.getUTCFullYear();
  if (da.getUTCMonth() === db.getUTCMonth()) {
    return `${da.getUTCDate()}–${db.getUTCDate()} ${MONTHS_GEN[db.getUTCMonth()]} ${year}`;
  }
  return `${da.getUTCDate()} ${MONTHS_GEN[da.getUTCMonth()]} – ${db.getUTCDate()} ${MONTHS_GEN[db.getUTCMonth()]} ${year}`;
}

/** Календарных дней пересечения двух периодов; null, если пересечения нет. */
export function overlapDays(
  aFrom: string | null,
  aTo: string | null,
  bFrom: string,
  bTo: string
): number | null {
  const a1 = parseDay(aFrom);
  const a2 = parseDay(aTo);
  const b1 = parseDay(bFrom);
  const b2 = parseDay(bTo);
  if (a1 === null || a2 === null || b1 === null || b2 === null) return null;
  const from = Math.max(a1, b1);
  const to = Math.min(a2, b2);
  if (to < from) return null;
  return Math.round((to - from) / MS_PER_DAY) + 1;
}

/** % готовности этапа, пересчитанный от набранного натурального объёма. */
export function progressFromVolume(
  volumeTotal: number | null,
  volumeDone: number
): number | null {
  if (volumeTotal === null || !(volumeTotal > 0)) return null;
  return clampPercent((volumeDone / volumeTotal) * 100);
}

/** Производные показатели строки задания. */
export interface ItemDerived {
  /** Выполнение недельного объёма: факт / план, %. */
  completion: number | null;
  /** Недовыполненный объём за неделю. */
  volumeLeft: number | null;
  /** Факт − план по проценту готовности этапа, п.п. */
  deviation: number | null;
  done: boolean;
}

export function itemDerived(item: WeeklyItem): ItemDerived {
  const vp = item.volume_plan === null ? null : Number(item.volume_plan);
  const vf = item.volume_fact === null ? null : Number(item.volume_fact);
  const pp = item.progress_plan === null ? null : Number(item.progress_plan);
  const pf = item.progress_fact === null ? null : Number(item.progress_fact);

  const completion = vp !== null && vp > 0 && vf !== null ? clampPercent((vf / vp) * 100) : null;
  const volumeLeft = vp !== null ? Math.max(0, vp - (vf || 0)) : null;
  const deviation = pp !== null && pf !== null ? Math.round((pf - pp) * 10) / 10 : null;

  // Строка закрыта, когда выбран весь недельный объём либо достигнут плановый процент.
  const byVolume = vp !== null && vp > 0 && vf !== null && vf >= vp;
  const byPercent = pp !== null && pf !== null && pf >= pp;
  const done = vp !== null && vp > 0 ? byVolume : byPercent;

  return { completion, volumeLeft, deviation, done };
}

/** Заготовка строки будущего задания — ещё без id, до записи в БД. */
export interface DraftItem {
  task_id: string | null;
  name: string;
  unit: string | null;
  volume_plan: number | null;
  progress_plan: number | null;
  /**
   * Достигнутая готовность этапа на момент выдачи задания. Не «сделано за неделю»,
   * а отправная точка: прораб видит, откуда двигаться, и правит вверх.
   */
  progress_fact: number | null;
  crew: string | null;
  note: string | null;
  sort_order: number;
  /** Откуда строка взялась — показывается прорабу в черновике. */
  origin: "carryover" | "schedule";
}

export interface DraftInput {
  /** Строки предыдущего задания — из них берутся остатки. */
  prevItems: WeeklyItem[];
  /** Листья графика: по группам задания не выдают. */
  leaves: TaskNode[];
  /** Набранный объём по этапу за все прошлые недели, включая предыдущую. */
  doneByTask: Map<string, number>;
  weekStart: string;
  weekEnd: string;
}

/**
 * Черновик следующей недели: сначала невыполненные остатки текущей,
 * затем этапы графика, чьи плановые сроки попадают на новую неделю.
 */
export function buildDraft(input: DraftInput): DraftItem[] {
  const { prevItems, leaves, doneByTask, weekStart, weekEnd } = input;
  const leafById = new Map<string, TaskNode>();
  leaves.forEach((n) => leafById.set(n.task.id, n));

  const out: DraftItem[] = [];
  const taken = new Set<string>();
  let order = 0;

  // 1. Остатки предыдущей недели.
  for (const it of prevItems.slice().sort((a, b) => a.sort_order - b.sort_order)) {
    const d = itemDerived(it);
    if (d.done) continue;
    const node = it.task_id ? leafById.get(it.task_id) : undefined;
    // Этап, закрытый в графике целиком, тянуть в новую неделю не нужно.
    if (node && node.progressFact >= 100) continue;

    const left = d.volumeLeft;
    const hasVolume = it.volume_plan !== null && Number(it.volume_plan) > 0;
    if (hasVolume && (left === null || left <= 0)) continue;

    order += 10;
    if (it.task_id) taken.add(it.task_id);
    out.push({
      task_id: it.task_id,
      name: it.name,
      unit: it.unit,
      volume_plan: hasVolume ? left : null,
      progress_plan: it.progress_plan,
      progress_fact: node ? node.progressFact : it.progress_fact,
      crew: it.crew,
      note: "Перенос с прошлой недели",
      sort_order: order,
      origin: "carryover",
    });
  }

  // 2. Новые этапы, попадающие в неделю по плановым срокам.
  for (const n of leaves) {
    if (taken.has(n.task.id)) continue;
    if (n.progressFact >= 100) continue;
    const overlap = overlapDays(n.startPlan, n.endPlan, weekStart, weekEnd);
    if (overlap === null) continue;

    const done = doneByTask.get(n.task.id) || 0;
    const hasTotal = n.volumeTotal !== null && n.volumeTotal > 0;
    let volumePlan: number | null = null;
    let progressPlan: number | null = null;

    if (n.tracking === "volume" && hasTotal && n.durationPlan) {
      // Долю объёма считаем по дням пересечения, но не больше оставшегося.
      const share = (n.volumeTotal! * overlap) / n.durationPlan;
      const left = Math.max(0, n.volumeTotal! - done);
      volumePlan = roundVolume(Math.min(share, left), n.unit);
      if (volumePlan <= 0) continue;
      progressPlan = progressFromVolume(n.volumeTotal, done + volumePlan);
    } else {
      // Задание выдаётся процентом. Если объём у этапа всё же задан, переводим
      // целевой процент в понятные прорабу единицы — не дробя по дням.
      progressPlan = planProgress(n.startPlan, n.endPlan, weekEnd);
      if (hasTotal && progressPlan !== null) {
        const target = (n.volumeTotal! * progressPlan) / 100 - done;
        const left = Math.max(0, n.volumeTotal! - done);
        const value = roundVolume(Math.min(Math.max(0, target), left), n.unit);
        volumePlan = value > 0 ? value : null;
      }
    }

    order += 10;
    out.push({
      task_id: n.task.id,
      name: n.task.name,
      unit: n.unit,
      volume_plan: volumePlan,
      progress_plan: progressPlan,
      progress_fact: n.progressFact > 0 ? n.progressFact : null,
      crew: null,
      note: null,
      sort_order: order,
      origin: "schedule",
    });
  }

  return out;
}

/** Итоги задания для шапки модуля. */
export interface WeeklySummary {
  total: number;
  done: number;
  open: number;
  volumePlan: number | null;
  volumeFact: number | null;
  /** Общее выполнение недели по объёму, %. Считается только по строкам с объёмом. */
  completion: number | null;
  /** Единица, если она у всех строк с объёмом одна. */
  unit: string | null;
}

export function summarizeWeek(items: WeeklyItem[]): WeeklySummary {
  let done = 0;
  const withVolume = items.filter((i) => i.volume_plan !== null && Number(i.volume_plan) > 0);
  items.forEach((i) => {
    if (itemDerived(i).done) done++;
  });

  const units = new Set(withVolume.map((i) => i.unit || ""));
  const sameUnit = withVolume.length > 0 && units.size === 1;
  const volumePlan = withVolume.length
    ? withVolume.reduce((s, i) => s + Number(i.volume_plan || 0), 0)
    : null;
  const volumeFact = withVolume.length
    ? withVolume.reduce((s, i) => s + Number(i.volume_fact || 0), 0)
    : null;

  return {
    total: items.length,
    done,
    open: items.length - done,
    volumePlan: sameUnit ? volumePlan : null,
    volumeFact: sameUnit ? volumeFact : null,
    completion:
      volumePlan !== null && volumePlan > 0 && volumeFact !== null
        ? clampPercent((volumeFact / volumePlan) * 100)
        : null,
    unit: sameUnit ? withVolume[0].unit : null,
  };
}

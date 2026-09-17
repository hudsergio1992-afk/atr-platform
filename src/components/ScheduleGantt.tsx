"use client";

import { useEffect, useMemo, useRef } from "react";
import { SCHEDULE_STATUS_CLASS, SCHEDULE_STATUS_LABEL } from "@/lib/types";
import { dayToISO, parseDay, TaskNode } from "@/lib/schedule";
import { fmtDate, fmtPercent } from "@/lib/format";

export type GanttScale = "day" | "week" | "month";

/** Ширина одного дня шкалы в пикселях для каждого масштаба. */
const PX_PER_DAY: Record<GanttScale, number> = { day: 26, week: 7, month: 2.4 };
const MS_PER_DAY = 86_400_000;

const MONTHS_SHORT = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

interface Tick {
  key: string;
  left: number;
  width: number;
  label: string;
  weekend: boolean;
}

interface Props {
  rows: TaskNode[];
  today: string;
  scale: GanttScale;
  selectedId: string | null;
  onPick: (id: string) => void;
}

export default function ScheduleGantt({ rows, today, scale, selectedId, onPick }: Props) {
  const model = useMemo(() => {
    const starts: number[] = [];
    const ends: number[] = [];
    for (const r of rows) {
      for (const v of [r.startPlan, r.startFact]) {
        const d = parseDay(v);
        if (d !== null) starts.push(d);
      }
      for (const v of [r.endPlan, r.endFact]) {
        const d = parseDay(v);
        if (d !== null) ends.push(d);
      }
    }
    if (!starts.length || !ends.length) return null;

    const todayMs = parseDay(today);
    let from = Math.min(...starts);
    let to = Math.max(...ends);
    if (todayMs !== null) {
      from = Math.min(from, todayMs);
      to = Math.max(to, todayMs);
    }
    // Поля по краям, чтобы крайние полосы не липли к границе шкалы.
    const pad = scale === "day" ? 2 : scale === "week" ? 7 : 20;
    from -= pad * MS_PER_DAY;
    to += pad * MS_PER_DAY;

    const ppd = PX_PER_DAY[scale];
    const totalDays = Math.round((to - from) / MS_PER_DAY) + 1;
    const width = totalDays * ppd;

    const offset = (iso: string | null): number | null => {
      const d = parseDay(iso);
      if (d === null) return null;
      return (Math.round((d - from) / MS_PER_DAY)) * ppd;
    };
    const span = (a: string | null, b: string | null): { left: number; width: number } | null => {
      const l = offset(a);
      const r = offset(b);
      if (l === null || r === null) return null;
      const w = Math.max(r - l + ppd, ppd);
      return { left: l, width: w };
    };

    // Верхний ряд — месяцы, нижний — деления выбранного масштаба.
    const months: Tick[] = [];
    const ticks: Tick[] = [];
    const cur = new Date(from);
    cur.setUTCHours(0, 0, 0, 0);

    let mCursor = Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth(), 1);
    while (mCursor <= to) {
      const next = Date.UTC(new Date(mCursor).getUTCFullYear(), new Date(mCursor).getUTCMonth() + 1, 1);
      const visibleFrom = Math.max(mCursor, from);
      const visibleTo = Math.min(next - MS_PER_DAY, to);
      const left = (Math.round((visibleFrom - from) / MS_PER_DAY)) * ppd;
      const w = (Math.round((visibleTo - visibleFrom) / MS_PER_DAY) + 1) * ppd;
      const d = new Date(mCursor);
      months.push({
        key: `m${mCursor}`,
        left,
        width: w,
        label: `${MONTHS_SHORT[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`,
        weekend: false,
      });
      mCursor = next;
    }

    if (scale === "day") {
      for (let t = from; t <= to; t += MS_PER_DAY) {
        const d = new Date(t);
        const dow = d.getUTCDay();
        ticks.push({
          key: `d${t}`,
          left: (Math.round((t - from) / MS_PER_DAY)) * ppd,
          width: ppd,
          label: String(d.getUTCDate()),
          weekend: dow === 0 || dow === 6,
        });
      }
    } else if (scale === "week") {
      // Выравнивание на понедельник.
      let t = from;
      const shift = (new Date(t).getUTCDay() + 6) % 7;
      t -= shift * MS_PER_DAY;
      for (; t <= to; t += 7 * MS_PER_DAY) {
        const d = new Date(t);
        ticks.push({
          key: `w${t}`,
          left: (Math.round((t - from) / MS_PER_DAY)) * ppd,
          width: 7 * ppd,
          label: `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}`,
          weekend: false,
        });
      }
    }

    return {
      width,
      months,
      ticks,
      offset,
      span,
      todayLeft: todayMs === null ? null : (Math.round((todayMs - from) / MS_PER_DAY)) * ppd + ppd / 2,
      fromISO: dayToISO(from),
    };
  }, [rows, today, scale]);

  // Шкала может тянуться на год: при открытии подводим её к сегодняшнему дню,
  // иначе пользователь видит начало стройки и должен скроллить вручную.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const todayLeft = model?.todayLeft ?? null;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || todayLeft === null) return;
    el.scrollLeft = Math.max(0, todayLeft - el.clientWidth / 3);
  }, [todayLeft, scale]);

  if (!rows.length) {
    return <div className="empty-state">Этапов пока нет — добавьте первый.</div>;
  }
  if (!model) {
    return (
      <div className="empty-state">
        У этапов не заполнены даты — диаграмму строить не из чего. Укажите плановые сроки.
      </div>
    );
  }

  return (
    <div className="gantt">
      <div className="gantt-names">
        <div className="gantt-names-head">Этап</div>
        {rows.map((r) => (
          <div
            key={r.task.id}
            className={`gantt-name${r.isGroup ? " is-group" : ""}${selectedId === r.task.id ? " is-sel" : ""}`}
            style={{ paddingLeft: 10 + r.level * 14 }}
            onClick={() => onPick(r.task.id)}
            title={r.task.name}
          >
            {r.task.name}
          </div>
        ))}
      </div>

      <div className="gantt-scroll" ref={scrollRef}>
        <div className="gantt-canvas" style={{ width: model.width }}>
          <div className="gantt-head">
            <div className="gantt-months">
              {model.months.map((m) => (
                <div key={m.key} className="gantt-month" style={{ left: m.left, width: m.width }}>
                  <span>{m.label}</span>
                </div>
              ))}
            </div>
            {model.ticks.length > 0 && (
              <div className="gantt-ticks">
                {model.ticks.map((t) => (
                  <div
                    key={t.key}
                    className={`gantt-tick${t.weekend ? " is-weekend" : ""}`}
                    style={{ left: t.left, width: t.width }}
                  >
                    <span>{t.label}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="gantt-body">
            {scale === "day" &&
              model.ticks
                .filter((t) => t.weekend)
                .map((t) => (
                  <div key={`wk${t.key}`} className="gantt-weekend" style={{ left: t.left, width: t.width }} />
                ))}

            {model.todayLeft !== null && (
              <div className="gantt-today" style={{ left: model.todayLeft }} title={`Сегодня ${fmtDate(today)}`} />
            )}

            {rows.map((r) => {
              const plan = model.span(r.startPlan, r.endPlan);
              // Факт: от фактического начала до фактического окончания, а пока
              // работа идёт — до сегодняшнего дня.
              const factEnd = r.endFact || (r.startFact ? today : null);
              const fact = model.span(r.startFact, factEnd);
              const cls = SCHEDULE_STATUS_CLASS[r.status];
              return (
                <div
                  key={r.task.id}
                  className={`gantt-row${selectedId === r.task.id ? " is-sel" : ""}`}
                  onClick={() => onPick(r.task.id)}
                >
                  {plan && (
                    <div
                      className={`gantt-bar plan ${cls}${r.isGroup ? " is-group" : ""}`}
                      style={{ left: plan.left, width: plan.width }}
                      title={`План: ${fmtDate(r.startPlan)} – ${fmtDate(r.endPlan)} · факт ${fmtPercent(
                        r.progressFact
                      )} · ${SCHEDULE_STATUS_LABEL[r.status]}`}
                    >
                      <div className="gantt-fill" style={{ width: `${r.progressFact}%` }} />
                    </div>
                  )}
                  {fact && (
                    <div
                      className={`gantt-bar fact ${cls}`}
                      style={{ left: fact.left, width: fact.width }}
                      title={`Факт: ${fmtDate(r.startFact)} – ${r.endFact ? fmtDate(r.endFact) : "в работе"}`}
                    />
                  )}
                  {!plan && !fact && <div className="gantt-nodate">даты не заданы</div>}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

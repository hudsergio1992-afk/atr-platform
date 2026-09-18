"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import {
  ConstructionObject,
  HistoryEntry,
  ScheduleTask,
  UNITS,
  WEEKLY_STATUS_CLASS,
  WEEKLY_STATUS_LABEL,
  WeeklyAssignment,
  WeeklyItem,
  WeeklyStatus,
} from "@/lib/types";
import { buildTree, clampPercent, flattenTree, TaskNode } from "@/lib/schedule";
import {
  buildDraft,
  isoWeekNumber,
  itemDerived,
  mondayOf,
  progressFromVolume,
  shiftWeeks,
  summarizeWeek,
  weekEndOf,
  weekLabel,
} from "@/lib/weekly";
import { fmtDate, fmtDateTime, fmtDeviation, fmtNum, fmtPercent } from "@/lib/format";
import { readSetting, useToday, writeSetting } from "@/lib/useClient";

const LS_OBJECT_KEY = "atr.weekly.objectId";

interface FormState {
  taskId: string;
  name: string;
  unit: string;
  volumePlan: string;
  progressPlan: string;
  crew: string;
  note: string;
  sortOrder: string;
}

const EMPTY_FORM: FormState = {
  taskId: "",
  name: "",
  unit: "",
  volumePlan: "",
  progressPlan: "",
  crew: "",
  note: "",
  sortOrder: "",
};

const FIELD_LABEL: Record<keyof FormState, string> = {
  taskId: "Этап графика",
  name: "Работа",
  unit: "Ед. изм.",
  volumePlan: "Объём на неделю",
  progressPlan: "% готовности план",
  crew: "Бригада",
  note: "Примечание",
  sortOrder: "Порядок",
};

function toForm(i: WeeklyItem | null): FormState {
  if (!i) return { ...EMPTY_FORM };
  return {
    taskId: i.task_id || "",
    name: i.name,
    unit: i.unit || "",
    volumePlan: i.volume_plan != null ? String(i.volume_plan) : "",
    progressPlan: i.progress_plan != null ? String(i.progress_plan) : "",
    crew: i.crew || "",
    note: i.note || "",
    sortOrder: String(i.sort_order ?? 0),
  };
}

function diffText(old: WeeklyItem | null, form: FormState, taskName: (id: string) => string): string {
  const oldForm = toForm(old);
  const parts: string[] = [];
  (Object.keys(FIELD_LABEL) as (keyof FormState)[]).forEach((k) => {
    const ov = (oldForm[k] ?? "").trim();
    const nv = (form[k] ?? "").trim();
    if (ov === nv) return;
    const disp = (v: string) => {
      if (!v) return "—";
      if (k === "taskId") return taskName(v);
      if (k === "progressPlan") return `${v}%`;
      return v;
    };
    parts.push(`${FIELD_LABEL[k]}: ${disp(ov)} → ${disp(nv)}`);
  });
  return parts.join("; ");
}

export default function WeeklyModule() {
  const today = useToday();

  const [objects, setObjects] = useState<ConstructionObject[]>([]);
  const [objectId, setObjectId] = useState<string>("");
  const [tasks, setTasks] = useState<ScheduleTask[]>([]);
  const [assignments, setAssignments] = useState<WeeklyAssignment[]>([]);
  const [items, setItems] = useState<WeeklyItem[]>([]);

  const [loadingObjects, setLoadingObjects] = useState(true);
  const [loadingWeek, setLoadingWeek] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [weekOverride, setWeekOverride] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  const [panelOpen, setPanelOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  // Черновые значения полей факта: строка правится в таблице и пишется в БД по уходу из поля.
  const [factDraft, setFactDraft] = useState<Record<string, { vf?: string; pf?: string }>>({});

  const weekStart = weekOverride ?? (today ? mondayOf(today) : null);

  const loadObjects = useCallback(async () => {
    setLoadingObjects(true);
    const { data, error } = await supabase
      .from("objects")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) {
      setBanner("Не удалось загрузить объекты: " + error.message);
      setLoadingObjects(false);
      return;
    }
    const list = (data as ConstructionObject[]) || [];
    setObjects(list);
    const saved = readSetting(LS_OBJECT_KEY) || "";
    setObjectId(list.find((o) => o.id === saved)?.id || list[0]?.id || "");
    setLoadingObjects(false);
  }, []);

  const loadWeekData = useCallback(async (id: string) => {
    if (!id) {
      setTasks([]);
      setAssignments([]);
      setItems([]);
      return;
    }
    setLoadingWeek(true);
    const [tasksRes, asgRes] = await Promise.all([
      supabase.from("schedule_tasks").select("*").eq("object_id", id).order("sort_order"),
      supabase.from("weekly_assignments").select("*").eq("object_id", id).order("week_start", { ascending: false }),
    ]);
    if (tasksRes.error) setBanner("Не удалось загрузить график: " + tasksRes.error.message);
    if (asgRes.error) setBanner("Не удалось загрузить задания: " + asgRes.error.message);

    const asg = (asgRes.data as WeeklyAssignment[]) || [];
    setTasks((tasksRes.data as ScheduleTask[]) || []);
    setAssignments(asg);

    if (asg.length) {
      // Строки всех недель разом: накопленный объём по этапу нужен для расчёта остатков.
      const { data, error } = await supabase
        .from("weekly_items")
        .select("*")
        .in("assignment_id", asg.map((a) => a.id))
        .order("sort_order");
      if (error) setBanner("Не удалось загрузить строки заданий: " + error.message);
      setItems((data as WeeklyItem[]) || []);
    } else {
      setItems([]);
    }
    setLoadingWeek(false);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- состояние ставится после await, не синхронно
    loadObjects();
  }, [loadObjects]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- состояние ставится после await, не синхронно
    loadWeekData(objectId);
  }, [objectId, loadWeekData]);

  const tree = useMemo(() => (today ? buildTree(tasks, today) : []), [tasks, today]);
  const leaves = useMemo(() => flattenTree(tree).filter((n) => !n.isGroup), [tree]);
  const nodeById = useMemo(() => {
    const m = new Map<string, TaskNode>();
    flattenTree(tree).forEach((n) => m.set(n.task.id, n));
    return m;
  }, [tree]);

  const assignment = useMemo(
    () => assignments.find((a) => a.week_start === weekStart) || null,
    [assignments, weekStart]
  );

  const weekItems = useMemo(
    () =>
      assignment
        ? items.filter((i) => i.assignment_id === assignment.id).slice().sort((a, b) => a.sort_order - b.sort_order)
        : [],
    [items, assignment]
  );

  const summary = useMemo(() => summarizeWeek(weekItems), [weekItems]);
  const locked = assignment?.status === "closed";

  /** Набранный объём по этапу за все недели — основа для остатков и % готовности. */
  const doneByTask = useMemo(() => {
    const m = new Map<string, number>();
    items.forEach((i) => {
      if (!i.task_id || i.volume_fact === null) return;
      m.set(i.task_id, (m.get(i.task_id) || 0) + Number(i.volume_fact));
    });
    return m;
  }, [items]);

  const taskName = useCallback(
    (id: string) => nodeById.get(id)?.task.name || "этап вне графика",
    [nodeById]
  );

  function changeObject(id: string) {
    setObjectId(id);
    setDetailId(null);
    setPendingDeleteId(null);
    setFactDraft({});
    writeSetting(LS_OBJECT_KEY, id);
  }

  function goWeek(delta: number) {
    if (!weekStart) return;
    setWeekOverride(shiftWeeks(weekStart, delta));
    setDetailId(null);
    setFactDraft({});
  }

  async function createAssignment(fromDraft: boolean) {
    if (!objectId || !weekStart) return;
    setBusy(true);
    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from("weekly_assignments")
      .insert({
        object_id: objectId,
        week_start: weekStart,
        status: "draft",
        history: [{ at: now, text: fromDraft ? "Черновик сформирован по графику" : "Задание создано" }],
        created_at: now,
        updated_at: now,
      })
      .select()
      .single();
    if (error || !data) {
      setBanner("Не удалось создать задание: " + (error?.message || "пустой ответ"));
      setBusy(false);
      return;
    }
    const created = data as WeeklyAssignment;

    if (fromDraft) {
      const prev = assignments.find((a) => a.week_start === shiftWeeks(weekStart, -1));
      const prevItems = prev ? items.filter((i) => i.assignment_id === prev.id) : [];
      const drafts = buildDraft({
        prevItems,
        leaves,
        doneByTask,
        weekStart,
        weekEnd: weekEndOf(weekStart),
      });
      if (drafts.length) {
        const rows = drafts.map((d) => ({
          assignment_id: created.id,
          task_id: d.task_id,
          sort_order: d.sort_order,
          name: d.name,
          unit: d.unit,
          volume_plan: d.volume_plan,
          volume_fact: null,
          progress_plan: d.progress_plan,
          progress_fact: null,
          crew: d.crew,
          note: d.note,
          history: [
            {
              at: now,
              text: d.origin === "carryover" ? "Перенесено с прошлой недели" : "Добавлено из графика работ",
            },
          ],
          created_at: now,
          updated_at: now,
        }));
        const { error: itemsError } = await supabase.from("weekly_items").insert(rows);
        if (itemsError) setBanner("Задание создано, но строки не записались: " + itemsError.message);
      } else {
        setBanner("По графику на эту неделю работ не нашлось — задание создано пустым.");
      }
    }
    await loadWeekData(objectId);
    setBusy(false);
  }

  async function saveFact(item: WeeklyItem) {
    const draft = factDraft[item.id];
    if (!draft) return;
    const vfRaw = draft.vf;
    const pfRaw = draft.pf;

    const vf = vfRaw === undefined ? item.volume_fact : vfRaw === "" ? null : Number(vfRaw);
    const pf = pfRaw === undefined ? item.progress_fact : pfRaw === "" ? null : Number(pfRaw);
    if (vf !== null && (!Number.isFinite(vf) || vf < 0)) {
      setBanner("Фактический объём должен быть неотрицательным числом.");
      return;
    }
    if (pf !== null && (!Number.isFinite(pf) || pf < 0 || pf > 100)) {
      setBanner("% готовности факт должен быть от 0 до 100.");
      return;
    }
    if (vf === item.volume_fact && pf === item.progress_fact) {
      setFactDraft((cur) => {
        const next = { ...cur };
        delete next[item.id];
        return next;
      });
      return;
    }

    const now = new Date().toISOString();
    const parts: string[] = [];
    if (vf !== item.volume_fact) parts.push(`Объём факт: ${item.volume_fact ?? "—"} → ${vf ?? "—"}`);
    if (pf !== item.progress_fact) parts.push(`% факт: ${item.progress_fact ?? "—"} → ${pf ?? "—"}`);
    const history: HistoryEntry[] = [...(item.history || []), { at: now, text: parts.join("; ") }];

    const { error } = await supabase
      .from("weekly_items")
      .update({ volume_fact: vf, progress_fact: pf === null ? null : clampPercent(pf), history, updated_at: now })
      .eq("id", item.id);
    if (error) {
      setBanner("Не удалось сохранить факт: " + error.message);
      return;
    }
    setFactDraft((cur) => {
      const next = { ...cur };
      delete next[item.id];
      return next;
    });
    await loadWeekData(objectId);
  }

  /**
   * Перенос факта недели в график работ: где у этапа есть натуральный объём,
   * процент считается от набранного объёма, иначе берётся введённый вручную.
   */
  async function pushFactToSchedule(list: WeeklyItem[]): Promise<string[]> {
    const problems: string[] = [];
    const byTask = new Map<string, WeeklyItem[]>();
    list.forEach((i) => {
      if (!i.task_id) return;
      const arr = byTask.get(i.task_id);
      if (arr) arr.push(i);
      else byTask.set(i.task_id, [i]);
    });

    const now = new Date().toISOString();
    for (const [taskId, rows] of byTask) {
      const node = nodeById.get(taskId);
      if (!node) continue;

      let progress: number | null = null;
      if (node.tracking === "volume" && node.volumeTotal !== null && node.volumeTotal > 0) {
        progress = progressFromVolume(node.volumeTotal, doneByTask.get(taskId) || 0);
      } else {
        const percents = rows
          .map((r) => (r.progress_fact === null ? null : Number(r.progress_fact)))
          .filter((v): v is number => v !== null);
        if (percents.length) progress = clampPercent(Math.max(...percents));
      }
      if (progress === null) continue;
      if (Math.abs(progress - node.progressFact) < 0.05) continue;

      const week = rows[0];
      const patch: Record<string, unknown> = { progress_fact: progress, updated_at: now };
      if (!node.task.start_fact && progress > 0) patch.start_fact = assignment?.week_start || null;
      if (progress >= 100 && !node.task.end_fact) patch.end_fact = weekStart ? weekEndOf(weekStart) : null;

      const history: HistoryEntry[] = [
        ...(node.task.history || []),
        {
          at: now,
          text: `% готовности факт: ${fmtPercent(node.progressFact)} → ${fmtPercent(
            progress
          )} (закрытие недели ${weekLabel(assignment?.week_start || week.created_at)})`,
        },
      ];
      const { error } = await supabase
        .from("schedule_tasks")
        .update({ ...patch, history })
        .eq("id", taskId);
      if (error) problems.push(`${node.task.name}: ${error.message}`);
    }
    return problems;
  }

  async function changeStatus(status: WeeklyStatus) {
    if (!assignment) return;
    setBusy(true);
    const now = new Date().toISOString();
    const history: HistoryEntry[] = [
      ...(assignment.history || []),
      { at: now, text: `Статус: ${WEEKLY_STATUS_LABEL[assignment.status]} → ${WEEKLY_STATUS_LABEL[status]}` },
    ];
    const { error } = await supabase
      .from("weekly_assignments")
      .update({ status, history, updated_at: now })
      .eq("id", assignment.id);
    if (error) {
      setBanner("Не удалось изменить статус: " + error.message);
      setBusy(false);
      return;
    }
    if (status === "closed") {
      const problems = await pushFactToSchedule(weekItems);
      setBanner(
        problems.length
          ? "Неделя закрыта, но часть этапов графика не обновилась: " + problems.join("; ")
          : "Неделя закрыта, проценты готовности перенесены в график работ."
      );
    }
    await loadWeekData(objectId);
    setBusy(false);
  }

  function openPanel(id: string | null) {
    setEditingId(id);
    const it = id ? weekItems.find((x) => x.id === id) || null : null;
    if (it) {
      setForm(toForm(it));
    } else {
      const nextOrder = weekItems.reduce((m, x) => Math.max(m, x.sort_order ?? 0), 0) + 10;
      setForm({ ...EMPTY_FORM, sortOrder: String(nextOrder) });
    }
    setPanelOpen(true);
  }

  function closePanel() {
    setPanelOpen(false);
    setEditingId(null);
  }

  /** Выбор этапа подставляет его название, единицу и остаток объёма. */
  function pickTask(taskId: string) {
    if (!taskId) {
      setForm((f) => ({ ...f, taskId: "" }));
      return;
    }
    const node = nodeById.get(taskId);
    if (!node) {
      setForm((f) => ({ ...f, taskId }));
      return;
    }
    const done = doneByTask.get(taskId) || 0;
    const left =
      node.tracking === "volume" && node.volumeTotal !== null && node.volumeTotal > 0
        ? Math.max(0, Math.round((node.volumeTotal - done) * 1000) / 1000)
        : null;
    setForm((f) => ({
      ...f,
      taskId,
      name: f.name.trim() ? f.name : node.task.name,
      unit: node.unit || f.unit,
      volumePlan: left !== null && !f.volumePlan ? String(left) : f.volumePlan,
    }));
  }

  async function handleSave() {
    if (!assignment) {
      setBanner("Сначала создайте задание на эту неделю.");
      return;
    }
    if (!form.name.trim()) {
      setBanner("Укажите наименование работы.");
      return;
    }
    const vp = form.volumePlan === "" ? null : Number(form.volumePlan);
    if (vp !== null && (!Number.isFinite(vp) || vp < 0)) {
      setBanner("Объём на неделю должен быть неотрицательным числом.");
      return;
    }
    const pp = form.progressPlan === "" ? null : Number(form.progressPlan);
    if (pp !== null && (!Number.isFinite(pp) || pp < 0 || pp > 100)) {
      setBanner("% готовности план должен быть от 0 до 100.");
      return;
    }

    setBanner(null);
    setSaving(true);
    const now = new Date().toISOString();
    const order = Number(form.sortOrder);
    const payload = {
      assignment_id: assignment.id,
      task_id: form.taskId || null,
      sort_order: Number.isFinite(order) ? order : 0,
      name: form.name.trim(),
      unit: form.unit.trim() || null,
      volume_plan: vp,
      progress_plan: pp === null ? null : clampPercent(pp),
      crew: form.crew.trim() || null,
      note: form.note.trim() || null,
      updated_at: now,
    };

    if (editingId) {
      const old = weekItems.find((x) => x.id === editingId) || null;
      const change = diffText(old, form, taskName);
      const history: HistoryEntry[] = [
        ...(old?.history || []),
        { at: now, text: change || "Данные сохранены без изменений" },
      ];
      const { error } = await supabase
        .from("weekly_items")
        .update({ ...payload, history })
        .eq("id", editingId);
      if (error) setBanner("Не удалось сохранить строку: " + error.message);
      else {
        closePanel();
        await loadWeekData(objectId);
      }
    } else {
      const { error } = await supabase
        .from("weekly_items")
        .insert({ ...payload, volume_fact: null, progress_fact: null, created_at: now, history: [{ at: now, text: "Строка добавлена" }] });
      if (error) setBanner("Не удалось добавить строку: " + error.message);
      else {
        closePanel();
        await loadWeekData(objectId);
      }
    }
    setSaving(false);
  }

  async function deleteItem(id: string) {
    const { error } = await supabase.from("weekly_items").delete().eq("id", id);
    if (error) setBanner("Не удалось удалить строку: " + error.message);
    else {
      if (detailId === id) setDetailId(null);
      await loadWeekData(objectId);
    }
    setPendingDeleteId(null);
  }

  async function deleteAssignment() {
    if (!assignment) return;
    setBusy(true);
    const { error } = await supabase.from("weekly_assignments").delete().eq("id", assignment.id);
    if (error) setBanner("Не удалось удалить задание: " + error.message);
    else await loadWeekData(objectId);
    setBusy(false);
  }

  function renderDetail(item: WeeklyItem) {
    const d = itemDerived(item);
    const history = (item.history || []).slice().reverse();
    const node = item.task_id ? nodeById.get(item.task_id) : null;
    return (
      <div className="detail">
        <div className="detail-block">
          <h4>Строка задания</h4>
          <dl>
            <dt>Этап графика</dt>
            <dd>{node ? node.task.name : "вне графика"}</dd>
            <dt>Объём план</dt>
            <dd className="mono">
              {item.volume_plan != null ? `${fmtNum(item.volume_plan, 3)} ${item.unit || ""}`.trim() : "—"}
            </dd>
            <dt>Объём факт</dt>
            <dd className="mono">
              {item.volume_fact != null ? `${fmtNum(item.volume_fact, 3)} ${item.unit || ""}`.trim() : "—"}
            </dd>
            <dt>Остаток</dt>
            <dd className="mono">
              {d.volumeLeft != null ? `${fmtNum(d.volumeLeft, 3)} ${item.unit || ""}`.trim() : "—"}
            </dd>
            <dt>Выполнение</dt>
            <dd className="mono">{fmtPercent(d.completion)}</dd>
            <dt>% готовности</dt>
            <dd className="mono">
              план {fmtPercent(item.progress_plan)} · факт{" "}
              {fmtPercent(
                node && node.tracking === "volume" && node.volumeTotal !== null && node.volumeTotal > 0
                  ? progressFromVolume(node.volumeTotal, doneByTask.get(item.task_id as string) || 0)
                  : item.progress_fact
              )}
            </dd>
            <dt>Отклонение</dt>
            <dd className="mono">{fmtDeviation(d.deviation)}</dd>
            <dt>Бригада</dt>
            <dd>{item.crew || "—"}</dd>
            <dt>Примечание</dt>
            <dd>{item.note || "—"}</dd>
          </dl>
          {!locked && (
            <div className="detail-actions">
              <button
                className="btn btn-sm btn-ghost"
                onClick={(e) => {
                  e.stopPropagation();
                  openPanel(item.id);
                }}
              >
                Изменить
              </button>
              {pendingDeleteId === item.id ? (
                <button
                  className="btn btn-sm btn-danger"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteItem(item.id);
                  }}
                >
                  Точно удалить?
                </button>
              ) : (
                <button
                  className="btn btn-sm btn-ghost"
                  onClick={(e) => {
                    e.stopPropagation();
                    setPendingDeleteId(item.id);
                  }}
                >
                  Удалить
                </button>
              )}
            </div>
          )}
        </div>
        <div className="detail-block">
          <h4>История изменений</h4>
          {history.length ? (
            <ul className="history-list">
              {history.map((h, i) => (
                <li key={i}>
                  <time>{fmtDateTime(h.at)}</time>
                  {h.text}
                </li>
              ))}
            </ul>
          ) : (
            <p className="hint">Истории изменений пока нет.</p>
          )}
        </div>
      </div>
    );
  }

  function renderRow(item: WeeklyItem) {
    const d = itemDerived(item);
    const draft = factDraft[item.id] || {};
    const vfValue = draft.vf ?? (item.volume_fact != null ? String(item.volume_fact) : "");
    const hasVolume = item.volume_plan != null && Number(item.volume_plan) > 0;

    // Где есть натуральный объём, процент готовности однозначно из него и считается —
    // руками его вводят только для работ без измеримого объёма.
    const node = item.task_id ? nodeById.get(item.task_id) : null;
    const volumeDriven =
      hasVolume && node != null && node.tracking === "volume" && node.volumeTotal !== null && node.volumeTotal > 0;
    const factPercent = volumeDriven
      ? progressFromVolume(node!.volumeTotal, doneByTask.get(item.task_id as string) || 0)
      : item.progress_fact != null
      ? Number(item.progress_fact)
      : null;
    const deviation =
      item.progress_plan != null && factPercent != null
        ? Math.round((factPercent - Number(item.progress_plan)) * 10) / 10
        : null;
    const pfValue = draft.pf ?? (item.progress_fact != null ? String(item.progress_fact) : "");
    const cls = d.done ? "st-good" : deviation != null && deviation < -5 ? "st-bad" : "st-warn";

    return (
      <Fragment key={item.id}>
        <div className={`wk-row${detailId === item.id ? " is-open" : ""}`}>
          <div className="wk-c wk-c-name" onClick={() => setDetailId((c) => (c === item.id ? null : item.id))}>
            <span className="wk-name-text">{item.name}</span>
            {item.crew && <span className="wk-crew">{item.crew}</span>}
          </div>
          <div className="wk-c wk-c-plan mono">
            {item.volume_plan != null ? `${fmtNum(item.volume_plan, 3)} ${item.unit || ""}`.trim() : "—"}
          </div>
          <div className="wk-c wk-c-fact" data-label="Объём факт">
            <input
              className="wk-input mono"
              type="number"
              min={0}
              step="0.001"
              inputMode="decimal"
              placeholder={hasVolume ? "0" : "—"}
              disabled={locked}
              value={vfValue}
              onChange={(e) =>
                setFactDraft((cur) => ({ ...cur, [item.id]: { ...cur[item.id], vf: e.target.value } }))
              }
              onBlur={() => saveFact(item)}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
            />
          </div>
          <div className="wk-c wk-c-done mono">{fmtPercent(d.completion)}</div>
          <div className="wk-c wk-c-pp mono">{fmtPercent(item.progress_plan)}</div>
          <div className="wk-c wk-c-pf" data-label="% факт">
            {volumeDriven ? (
              <span className="wk-auto mono" title="Считается от набранного объёма">
                {fmtPercent(factPercent)}
              </span>
            ) : (
              <input
                className="wk-input mono"
                type="number"
                min={0}
                max={100}
                step="1"
                inputMode="decimal"
                placeholder="0"
                disabled={locked}
                value={pfValue}
                onChange={(e) =>
                  setFactDraft((cur) => ({ ...cur, [item.id]: { ...cur[item.id], pf: e.target.value } }))
                }
                onBlur={() => saveFact(item)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                }}
              />
            )}
          </div>
          <div className={`wk-c wk-c-dev mono${deviation != null && deviation < 0 ? " is-neg" : ""}`}>
            {fmtDeviation(deviation)}
          </div>
          <div className="wk-c wk-c-status" onClick={() => setDetailId((c) => (c === item.id ? null : item.id))}>
            <span className={`status-pill ${cls}`}>{d.done ? "Выполнено" : "В работе"}</span>
          </div>
          <div className="wk-c wk-c-meta" onClick={() => setDetailId((c) => (c === item.id ? null : item.id))}>
            <span className="mono">
              план {item.volume_plan != null ? `${fmtNum(item.volume_plan, 3)} ${item.unit || ""}`.trim() : "—"}
            </span>
            <span className="mono">выполнение {fmtPercent(d.completion)}</span>
            <span className={`mono${deviation != null && deviation < 0 ? " is-neg" : ""}`}>
              {fmtDeviation(deviation)}
            </span>
          </div>
        </div>
        {detailId === item.id && <div className="wk-detail-row">{renderDetail(item)}</div>}
      </Fragment>
    );
  }

  const prevAssignment = weekStart
    ? assignments.find((a) => a.week_start === shiftWeeks(weekStart, -1))
    : undefined;
  const weekNo = weekStart ? isoWeekNumber(weekStart) : null;
  const isCurrentWeek = !!today && !!weekStart && weekStart === mondayOf(today);

  return (
    <div>
      {banner && (
        <div className="banner show" onClick={() => setBanner(null)} role="status">
          {banner}
        </div>
      )}

      <div className="obj-picker">
        <label htmlFor="wk-object">Объект</label>
        <select
          id="wk-object"
          className="filter"
          value={objectId}
          onChange={(e) => changeObject(e.target.value)}
          disabled={loadingObjects || objects.length === 0}
        >
          {objects.length === 0 && <option value="">{loadingObjects ? "Загрузка…" : "Объектов нет"}</option>}
          {objects.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      </div>

      <div className="wk-weekbar">
        <button className="btn btn-sm btn-ghost" onClick={() => goWeek(-1)} disabled={!weekStart}>
          ←
        </button>
        <div className="wk-week">
          <span className="wk-week-title">
            {weekStart ? weekLabel(weekStart) : "—"}
            {weekNo !== null && <span className="wk-week-no">нед. {weekNo}</span>}
          </span>
          <span className="wk-week-sub mono">
            {weekStart ? `${fmtDate(weekStart)} – ${fmtDate(weekEndOf(weekStart))}` : ""}
          </span>
        </div>
        <button className="btn btn-sm btn-ghost" onClick={() => goWeek(1)} disabled={!weekStart}>
          →
        </button>
        {!isCurrentWeek && today && (
          <button className="btn btn-sm btn-ghost" onClick={() => setWeekOverride(mondayOf(today))}>
            Текущая неделя
          </button>
        )}
        {assignment && (
          <span className={`status-pill ${WEEKLY_STATUS_CLASS[assignment.status]}`}>
            {WEEKLY_STATUS_LABEL[assignment.status]}
          </span>
        )}
      </div>

      {assignment && (
        <div className="stats">
          <div className="stat-total">
            <span className="n">{summary.total}</span>
            <span className="l">работ в задании</span>
          </div>
          <div className="chip-row">
            <span className="chip st-good">
              <span className="n">{summary.done}</span> выполнено
            </span>
            <span className="chip st-warn">
              <span className="n">{summary.open}</span> в работе
            </span>
            {summary.volumePlan !== null && (
              <span className="chip st-neutral mono">
                объём {fmtNum(summary.volumeFact ?? 0, 3)} / {fmtNum(summary.volumePlan, 3)} {summary.unit || ""}
              </span>
            )}
            {summary.completion !== null && (
              <span className={`chip ${summary.completion >= 90 ? "st-good" : summary.completion >= 60 ? "st-warn" : "st-bad"}`}>
                выполнение <span className="n">{fmtPercent(summary.completion)}</span>
              </span>
            )}
          </div>
        </div>
      )}

      <div className="toolbar">
        {assignment ? (
          <>
            {assignment.status === "draft" && (
              <button className="btn btn-ghost" onClick={() => changeStatus("issued")} disabled={busy}>
                Выдать в работу
              </button>
            )}
            {assignment.status === "issued" && (
              <button className="btn btn-ghost" onClick={() => changeStatus("closed")} disabled={busy}>
                Закрыть неделю
              </button>
            )}
            {assignment.status === "closed" && (
              <button className="btn btn-ghost" onClick={() => changeStatus("issued")} disabled={busy}>
                Открыть заново
              </button>
            )}
            {!prevAssignment && weekStart && (
              <span className="hint" style={{ margin: 0 }}>
                Задания за прошлую неделю нет — переносить нечего.
              </span>
            )}
            <button className="btn btn-primary" onClick={() => openPanel(null)} disabled={locked}>
              + Добавить работу
            </button>
          </>
        ) : (
          <>
            <button className="btn btn-ghost" onClick={() => createAssignment(true)} disabled={busy || !objectId}>
              Сформировать по графику
            </button>
            <button className="btn btn-primary" onClick={() => createAssignment(false)} disabled={busy || !objectId}>
              Создать пустое задание
            </button>
          </>
        )}
      </div>

      <div className="sch-wrap">
        <div className="wk-head">
          <div className="wk-c wk-c-name">Работа</div>
          <div className="wk-c wk-c-plan">Объём план</div>
          <div className="wk-c wk-c-fact">Объём факт</div>
          <div className="wk-c wk-c-done">Вып.</div>
          <div className="wk-c wk-c-pp">% план</div>
          <div className="wk-c wk-c-pf">% факт</div>
          <div className="wk-c wk-c-dev">Откл.</div>
          <div className="wk-c wk-c-status">Статус</div>
        </div>
        {loadingWeek || !today ? (
          <div className="empty-state">Загрузка…</div>
        ) : !objectId ? (
          <div className="empty-state">Сначала создайте объект в модуле «Объекты».</div>
        ) : !assignment ? (
          <div className="empty-state">
            Задания на эту неделю нет. «Сформировать по графику» перенесёт остаток прошлой недели
            и добавит этапы, чьи плановые сроки попадают на неё.
          </div>
        ) : weekItems.length === 0 ? (
          <div className="empty-state">В задании пока нет работ — добавьте первую.</div>
        ) : (
          weekItems.map(renderRow)
        )}
      </div>

      {assignment && !locked && weekItems.length === 0 && (
        <div className="wk-danger">
          <button className="btn btn-sm btn-ghost" onClick={deleteAssignment} disabled={busy}>
            Удалить пустое задание
          </button>
        </div>
      )}

      <div className={`overlay${panelOpen ? " show" : ""}`} onClick={closePanel} />
      <div className={`panel${panelOpen ? " show" : ""}`}>
        <div className="panel-head">
          <h3>{editingId ? "Изменить работу" : "Новая работа в задании"}</h3>
          <button className="panel-close" aria-label="Закрыть" onClick={closePanel}>
            ✕
          </button>
        </div>
        <div className="panel-body">
          <div className="field">
            <label>Этап графика работ</label>
            <select value={form.taskId} onChange={(e) => pickTask(e.target.value)}>
              <option value="">— вне графика —</option>
              {leaves.map((n) => (
                <option key={n.task.id} value={n.task.id}>
                  {n.task.name}
                </option>
              ))}
            </select>
            <p className="hint">
              Выбор этапа подставит название, единицу и остаток объёма. Работы вне графика
              тоже можно вписать — они не попадут в проценты этапов.
            </p>
          </div>
          <div className="field">
            <label>
              Наименование работы <span className="req">*</span>
            </label>
            <input
              type="text"
              placeholder="напр. Бетонирование ростверка, захватка 2"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>
          <div className="field-row">
            <div className="field">
              <label>Объём на неделю</label>
              <input
                type="number"
                min={0}
                step="0.001"
                placeholder="0"
                value={form.volumePlan}
                onChange={(e) => setForm({ ...form, volumePlan: e.target.value })}
              />
            </div>
            <div className="field">
              <label>Ед. изм.</label>
              <input
                type="text"
                list="atr-units-wk"
                placeholder="м³"
                value={form.unit}
                onChange={(e) => setForm({ ...form, unit: e.target.value })}
              />
              <datalist id="atr-units-wk">
                {UNITS.map((u) => (
                  <option key={u} value={u} />
                ))}
              </datalist>
            </div>
          </div>
          <div className="field-row">
            <div className="field">
              <label>% готовности план</label>
              <input
                type="number"
                min={0}
                max={100}
                step="1"
                placeholder="0"
                value={form.progressPlan}
                onChange={(e) => setForm({ ...form, progressPlan: e.target.value })}
              />
            </div>
            <div className="field">
              <label>Порядок</label>
              <input
                type="number"
                step="1"
                value={form.sortOrder}
                onChange={(e) => setForm({ ...form, sortOrder: e.target.value })}
              />
            </div>
          </div>
          <div className="field">
            <label>Бригада / исполнитель</label>
            <input
              type="text"
              placeholder="напр. бригада Петрова"
              value={form.crew}
              onChange={(e) => setForm({ ...form, crew: e.target.value })}
            />
          </div>
          <div className="field">
            <label>Примечание</label>
            <input
              type="text"
              placeholder="напр. после поставки арматуры"
              value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
            />
          </div>
        </div>
        <div className="panel-foot">
          <button className="btn btn-ghost" onClick={closePanel}>
            Отмена
          </button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? "Сохранение…" : "Сохранить"}
          </button>
        </div>
      </div>
    </div>
  );
}

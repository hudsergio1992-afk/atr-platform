"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { readSetting, useHydrated, useToday, writeSetting } from "@/lib/useClient";
import { supabase } from "@/lib/supabaseClient";
import {
  ConstructionObject,
  HistoryEntry,
  SCHEDULE_STATUS_CLASS,
  SCHEDULE_STATUS_LABEL,
  ScheduleStatus,
  ScheduleTask,
} from "@/lib/types";
import {
  buildTree,
  clampPercent,
  daysInclusive,
  flattenTree,
  planProgress,
  summarize,
  TaskNode,
} from "@/lib/schedule";
import {
  fmtDate,
  fmtDateTime,
  fmtDeviation,
  fmtNum,
  fmtPercent,
  fmtRange,
} from "@/lib/format";
import ScheduleGantt, { GanttScale } from "@/components/ScheduleGantt";

type ViewMode = "tree" | "table" | "gantt";
type SortKey =
  | "name"
  | "startPlan"
  | "endPlan"
  | "duration"
  | "normHours"
  | "progressPlan"
  | "progressFact"
  | "deviation"
  | "status";

const VIEW_LABEL: Record<ViewMode, string> = {
  tree: "Дерево",
  table: "Таблица",
  gantt: "Диаграмма Ганта",
};

const SCALE_LABEL: Record<GanttScale, string> = {
  day: "Дни",
  week: "Недели",
  month: "Месяцы",
};

const STATUS_ORDER: Record<ScheduleStatus, number> = { behind: 0, on_track: 1, closed: 2 };

const LS_OBJECT_KEY = "atr.schedule.objectId";
const LS_VIEW_KEY = "atr.schedule.view";

interface FormState {
  name: string;
  parentId: string;
  sortOrder: string;
  startPlan: string;
  endPlan: string;
  startFact: string;
  endFact: string;
  normHours: string;
  progressFact: string;
}

const EMPTY_FORM: FormState = {
  name: "",
  parentId: "",
  sortOrder: "",
  startPlan: "",
  endPlan: "",
  startFact: "",
  endFact: "",
  normHours: "",
  progressFact: "",
};

const FIELD_LABEL: Record<keyof FormState, string> = {
  name: "Наименование",
  parentId: "Родительский этап",
  sortOrder: "Порядок",
  startPlan: "Начало (план)",
  endPlan: "Окончание (план)",
  startFact: "Начало (факт)",
  endFact: "Окончание (факт)",
  normHours: "Нормочасы",
  progressFact: "% готовности факт",
};

function toForm(t: ScheduleTask | null): FormState {
  if (!t) return { ...EMPTY_FORM };
  return {
    name: t.name,
    parentId: t.parent_id || "",
    sortOrder: String(t.sort_order ?? 0),
    startPlan: t.start_plan || "",
    endPlan: t.end_plan || "",
    startFact: t.start_fact || "",
    endFact: t.end_fact || "",
    normHours: t.norm_hours != null ? String(t.norm_hours) : "",
    progressFact: t.progress_fact != null ? String(t.progress_fact) : "",
  };
}

function diffText(
  old: ScheduleTask | null,
  form: FormState,
  nameById: Map<string, string>
): string {
  const oldForm = toForm(old);
  const parts: string[] = [];
  (Object.keys(FIELD_LABEL) as (keyof FormState)[]).forEach((k) => {
    const ov = (oldForm[k] ?? "").trim();
    const nv = (form[k] ?? "").trim();
    if (ov === nv) return;
    const disp = (v: string) => {
      if (!v) return "—";
      if (k === "parentId") return nameById.get(v) || v;
      if (k.startsWith("start") || k.startsWith("end")) return fmtDate(v);
      if (k === "progressFact") return `${v}%`;
      return v;
    };
    parts.push(`${FIELD_LABEL[k]}: ${disp(ov)} → ${disp(nv)}`);
  });
  return parts.join("; ");
}

/** Оставляет узлы, подходящие под условие, вместе с их предками и потомками. */
function filterTree(nodes: TaskNode[], keep: (n: TaskNode) => boolean): TaskNode[] {
  const out: TaskNode[] = [];
  for (const n of nodes) {
    const kids = filterTree(n.children, keep);
    if (keep(n)) {
      out.push(n);
    } else if (kids.length) {
      out.push({ ...n, children: kids });
    }
  }
  return out;
}

/** Идентификаторы самого узла и всех его потомков — чтобы не назначить этап своим же родителем. */
function subtreeIds(node: TaskNode): string[] {
  const ids: string[] = [node.task.id];
  node.children.forEach((c) => ids.push(...subtreeIds(c)));
  return ids;
}

export default function ScheduleModule() {
  const [objects, setObjects] = useState<ConstructionObject[]>([]);
  const [objectId, setObjectId] = useState<string>("");
  const [tasks, setTasks] = useState<ScheduleTask[]>([]);
  const [loadingObjects, setLoadingObjects] = useState(true);
  const [loadingTasks, setLoadingTasks] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);

  // Дата берётся только на клиенте: на сервере «сегодня» может отличаться от часового пояса пользователя.
  const today = useToday();
  const hydrated = useHydrated();

  const [viewOverride, setViewOverride] = useState<ViewMode | null>(null);
  const storedView = useMemo(() => {
    if (!hydrated) return null;
    const v = readSetting(LS_VIEW_KEY);
    return v === "tree" || v === "table" || v === "gantt" ? v : null;
  }, [hydrated]);
  const view: ViewMode = viewOverride ?? storedView ?? "tree";
  const [scale, setScale] = useState<GanttScale>("week");
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState<string>("");
  const [sortKey, setSortKey] = useState<SortKey>("startPlan");
  const [sortAsc, setSortAsc] = useState(true);

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [detailId, setDetailId] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  const [panelOpen, setPanelOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

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
    const initial = list.find((o) => o.id === saved)?.id || list[0]?.id || "";
    setObjectId(initial);
    setLoadingObjects(false);
  }, []);

  const loadTasks = useCallback(async (id: string) => {
    if (!id) {
      setTasks([]);
      return;
    }
    setLoadingTasks(true);
    const { data, error } = await supabase
      .from("schedule_tasks")
      .select("*")
      .eq("object_id", id)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });
    if (error) {
      setBanner("Не удалось загрузить график: " + error.message);
      setTasks([]);
    } else {
      setTasks((data as ScheduleTask[]) || []);
    }
    setLoadingTasks(false);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- состояние ставится после await, не синхронно
    loadObjects();
  }, [loadObjects]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- состояние ставится после await, не синхронно
    loadTasks(objectId);
  }, [objectId, loadTasks]);

  const currentObject = useMemo(
    () => objects.find((o) => o.id === objectId) || null,
    [objects, objectId]
  );

  const tree = useMemo(
    () => (today ? buildTree(tasks, today) : []),
    [tasks, today]
  );

  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    tasks.forEach((t) => m.set(t.id, t.name));
    return m;
  }, [tasks]);

  const parentNameById = useMemo(() => {
    const m = new Map<string, string>();
    tasks.forEach((t) => {
      if (t.parent_id) m.set(t.id, nameById.get(t.parent_id) || "");
    });
    return m;
  }, [tasks, nameById]);

  const matches = useCallback(
    (n: TaskNode) => {
      const q = search.trim().toLowerCase();
      if (q && n.task.name.toLowerCase().indexOf(q) === -1) return false;
      if (filterStatus && n.status !== filterStatus) return false;
      return true;
    },
    [search, filterStatus]
  );

  const filteredTree = useMemo(() => {
    if (!search.trim() && !filterStatus) return tree;
    return filterTree(tree, matches);
  }, [tree, search, filterStatus, matches]);

  const summary = useMemo(() => summarize(tree), [tree]);

  const treeRows = useMemo(() => {
    // Плоский список видимых строк дерева: потомки свёрнутого узла пропускаются.
    const out: TaskNode[] = [];
    const walk = (list: TaskNode[]) => {
      for (const n of list) {
        out.push(n);
        if (n.children.length && !collapsed.has(n.task.id)) walk(n.children);
      }
    };
    walk(filteredTree);
    return out;
  }, [filteredTree, collapsed]);

  const tableRows = useMemo(() => {
    const rows = flattenTree(filteredTree).filter(matches);
    const dir = sortAsc ? 1 : -1;
    const val = (n: TaskNode): string | number | null => {
      switch (sortKey) {
        case "name": return n.task.name.toLowerCase();
        case "startPlan": return n.startPlan;
        case "endPlan": return n.endPlan;
        case "duration": return n.durationPlan;
        case "normHours": return n.normHours;
        case "progressPlan": return n.progressPlan;
        case "progressFact": return n.progressFact;
        case "deviation": return n.deviation;
        case "status": return STATUS_ORDER[n.status];
      }
    };
    return rows.slice().sort((a, b) => {
      const x = val(a);
      const y = val(b);
      // Пустые значения всегда в конце, независимо от направления сортировки.
      if (x === null || x === undefined) return y === null || y === undefined ? 0 : 1;
      if (y === null || y === undefined) return -1;
      if (typeof x === "number" && typeof y === "number") return (x - y) * dir;
      return String(x).localeCompare(String(y), "ru") * dir;
    });
  }, [filteredTree, matches, sortKey, sortAsc]);

  const ganttRows = useMemo(() => {
    const out: TaskNode[] = [];
    const walk = (list: TaskNode[]) => {
      for (const n of list) {
        out.push(n);
        if (n.children.length && !collapsed.has(n.task.id)) walk(n.children);
      }
    };
    walk(filteredTree);
    return out;
  }, [filteredTree, collapsed]);

  const nodeById = useMemo(() => {
    const m = new Map<string, TaskNode>();
    flattenTree(tree).forEach((n) => m.set(n.task.id, n));
    return m;
  }, [tree]);

  function changeObject(id: string) {
    setObjectId(id);
    setDetailId(null);
    setPendingDeleteId(null);
    setCollapsed(new Set());
    writeSetting(LS_OBJECT_KEY, id);
  }

  function changeView(v: ViewMode) {
    setViewOverride(v);
    writeSetting(LS_VIEW_KEY, v);
  }

  function toggleCollapse(id: string) {
    setCollapsed((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleDetail(id: string) {
    setDetailId((cur) => (cur === id ? null : id));
    setPendingDeleteId(null);
  }

  function openPanel(id: string | null, presetParent?: string) {
    setEditingId(id);
    const t = id ? tasks.find((x) => x.id === id) || null : null;
    if (t) {
      setForm(toForm(t));
    } else {
      const siblings = tasks.filter((x) => (x.parent_id || "") === (presetParent || ""));
      const nextOrder = siblings.reduce((max, x) => Math.max(max, x.sort_order ?? 0), 0) + 10;
      setForm({ ...EMPTY_FORM, parentId: presetParent || "", sortOrder: String(nextOrder) });
    }
    setPanelOpen(true);
  }

  function closePanel() {
    setPanelOpen(false);
    setEditingId(null);
  }

  function sortBy(key: SortKey) {
    if (key === sortKey) setSortAsc((v) => !v);
    else {
      setSortKey(key);
      setSortAsc(true);
    }
  }

  /** Этапы, доступные как родитель: без самого этапа и его потомков. */
  const parentOptions = useMemo(() => {
    const banned = new Set<string>();
    if (editingId) {
      const n = nodeById.get(editingId);
      if (n) subtreeIds(n).forEach((id) => banned.add(id));
    }
    return flattenTree(tree)
      .filter((n) => !banned.has(n.task.id))
      .map((n) => ({ id: n.task.id, label: `${"— ".repeat(n.level)}${n.task.name}` }));
  }, [tree, nodeById, editingId]);

  const editingNode = editingId ? nodeById.get(editingId) || null : null;
  const editingIsGroup = !!editingNode?.isGroup;

  /** Живой пересчёт производных прямо в форме, до сохранения. */
  const formPreview = useMemo(() => {
    if (editingIsGroup && editingNode) {
      return {
        duration: editingNode.durationPlan,
        progressPlan: editingNode.progressPlan,
        deviation: editingNode.deviation,
      };
    }
    const duration = daysInclusive(form.startPlan || null, form.endPlan || null);
    const pp = today ? planProgress(form.startPlan || null, form.endPlan || null, today) : null;
    const pf = clampPercent(Number(form.progressFact) || 0);
    return {
      duration,
      progressPlan: pp,
      deviation: pp === null ? null : Math.round((pf - pp) * 10) / 10,
    };
  }, [form.startPlan, form.endPlan, form.progressFact, today, editingIsGroup, editingNode]);

  async function handleSave() {
    if (!objectId) {
      setBanner("Сначала выберите объект.");
      return;
    }
    if (!form.name.trim()) {
      setBanner("Укажите наименование этапа.");
      return;
    }
    if (form.startPlan && form.endPlan && form.endPlan < form.startPlan) {
      setBanner("Плановое окончание раньше планового начала.");
      return;
    }
    if (form.startFact && form.endFact && form.endFact < form.startFact) {
      setBanner("Фактическое окончание раньше фактического начала.");
      return;
    }
    const pf = form.progressFact === "" ? 0 : Number(form.progressFact);
    if (!Number.isFinite(pf) || pf < 0 || pf > 100) {
      setBanner("% готовности факт должен быть числом от 0 до 100.");
      return;
    }
    const nh = form.normHours === "" ? null : Number(form.normHours);
    if (nh !== null && (!Number.isFinite(nh) || nh < 0)) {
      setBanner("Нормочасы должны быть неотрицательным числом.");
      return;
    }

    setBanner(null);
    setSaving(true);
    const now = new Date().toISOString();
    const order = Number(form.sortOrder);
    const payload = {
      object_id: objectId,
      parent_id: form.parentId || null,
      sort_order: Number.isFinite(order) ? order : 0,
      name: form.name.trim(),
      start_plan: form.startPlan || null,
      end_plan: form.endPlan || null,
      start_fact: form.startFact || null,
      end_fact: form.endFact || null,
      norm_hours: nh,
      progress_fact: clampPercent(pf),
      updated_at: now,
    };

    if (editingId) {
      const old = tasks.find((x) => x.id === editingId) || null;
      const change = diffText(old, form, nameById);
      const history: HistoryEntry[] = old?.history ? [...old.history] : [];
      history.push({ at: now, text: change || "Данные сохранены без изменений" });
      const { error } = await supabase
        .from("schedule_tasks")
        .update({ ...payload, history })
        .eq("id", editingId);
      if (error) {
        setBanner("Не удалось сохранить этап: " + error.message);
      } else {
        closePanel();
        await loadTasks(objectId);
      }
    } else {
      const history: HistoryEntry[] = [{ at: now, text: "Этап создан" }];
      const { error } = await supabase
        .from("schedule_tasks")
        .insert({ ...payload, created_at: now, history });
      if (error) {
        setBanner("Не удалось создать этап: " + error.message);
      } else {
        closePanel();
        await loadTasks(objectId);
      }
    }
    setSaving(false);
  }

  async function doDelete(id: string) {
    const { error } = await supabase.from("schedule_tasks").delete().eq("id", id);
    if (error) {
      setBanner("Не удалось удалить этап: " + error.message);
    } else {
      if (detailId === id) setDetailId(null);
      await loadTasks(objectId);
    }
    setPendingDeleteId(null);
  }

  function renderDetail(n: TaskNode) {
    const history = (n.task.history || []).slice().reverse();
    const kids = n.children.length;
    return (
      <div className="detail">
        <div className="detail-block">
          <h4>Показатели этапа</h4>
          <dl>
            <dt>Сроки план</dt>
            <dd className="mono">{fmtRange(n.startPlan, n.endPlan)}</dd>
            <dt>Сроки факт</dt>
            <dd className="mono">{fmtRange(n.startFact, n.endFact)}</dd>
            <dt>Длительность</dt>
            <dd className="mono">{n.durationPlan ? `${n.durationPlan} дн.` : "—"}</dd>
            <dt>Нормочасы</dt>
            <dd className="mono">{n.normHours != null ? `${fmtNum(n.normHours)} н/ч` : "—"}</dd>
            <dt>% план</dt>
            <dd className="mono">{fmtPercent(n.progressPlan)}</dd>
            <dt>% факт</dt>
            <dd className="mono">{fmtPercent(n.progressFact)}</dd>
            <dt>Отклонение</dt>
            <dd className="mono">{fmtDeviation(n.deviation)}</dd>
            <dt>Статус</dt>
            <dd>
              <span className={`status-pill ${SCHEDULE_STATUS_CLASS[n.status]}`}>
                {SCHEDULE_STATUS_LABEL[n.status]}
              </span>
            </dd>
          </dl>
          {n.isGroup && (
            <p className="hint">
              Этап содержит подэтапы: даты, нормочасы и проценты сведены по ним автоматически.
            </p>
          )}
          <div className="detail-actions">
            <button
              className="btn btn-sm btn-ghost"
              onClick={(e) => {
                e.stopPropagation();
                openPanel(n.task.id);
              }}
            >
              Изменить
            </button>
            <button
              className="btn btn-sm btn-ghost"
              onClick={(e) => {
                e.stopPropagation();
                openPanel(null, n.task.id);
              }}
            >
              + Подэтап
            </button>
            {pendingDeleteId === n.task.id ? (
              <button
                className="btn btn-sm btn-danger"
                onClick={(e) => {
                  e.stopPropagation();
                  doDelete(n.task.id);
                }}
              >
                {kids ? `Удалить вместе с ${kids} подэтап(ами)?` : "Точно удалить?"}
              </button>
            ) : (
              <button
                className="btn btn-sm btn-ghost"
                onClick={(e) => {
                  e.stopPropagation();
                  setPendingDeleteId(n.task.id);
                }}
              >
                Удалить
              </button>
            )}
          </div>
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

  function renderRow(n: TaskNode, mode: ViewMode) {
    const isTree = mode === "tree";
    const hasKids = n.children.length > 0;
    const isCollapsed = collapsed.has(n.task.id);
    const parentName = parentNameById.get(n.task.id);
    return (
      <Fragment key={n.task.id}>
        <div
          className={`sch-row${n.isGroup ? " is-group" : ""}${
            detailId === n.task.id ? " is-open" : ""
          }`}
          onClick={() => toggleDetail(n.task.id)}
        >
          <div
            className="sch-c sch-c-name"
            style={isTree ? { paddingLeft: 12 + n.level * 16 } : undefined}
          >
            {isTree && hasKids ? (
              <button
                className="sch-caret"
                aria-label={isCollapsed ? "Развернуть" : "Свернуть"}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleCollapse(n.task.id);
                }}
              >
                {isCollapsed ? "▸" : "▾"}
              </button>
            ) : (
              isTree && <span className="sch-caret placeholder" />
            )}
            <span className="sch-name-text">{n.task.name}</span>
            {!isTree && parentName && <span className="sch-parent">в составе «{parentName}»</span>}
          </div>
          <div className="sch-c sch-c-plan mono">{fmtRange(n.startPlan, n.endPlan)}</div>
          <div className="sch-c sch-c-dur mono">{n.durationPlan ?? "—"}</div>
          <div className="sch-c sch-c-nh mono">{n.normHours != null ? fmtNum(n.normHours) : "—"}</div>
          <div className="sch-c sch-c-fact mono">{fmtRange(n.startFact, n.endFact)}</div>
          <div className="sch-c sch-c-pp mono">{fmtPercent(n.progressPlan)}</div>
          <div className="sch-c sch-c-pf mono">
            <span className="sch-bar" aria-hidden>
              <span
                className={`sch-bar-fill ${SCHEDULE_STATUS_CLASS[n.status]}`}
                style={{ width: `${n.progressFact}%` }}
              />
            </span>
            {fmtPercent(n.progressFact)}
          </div>
          <div
            className={`sch-c sch-c-dev mono${
              n.deviation != null && n.deviation < 0 ? " is-neg" : ""
            }`}
          >
            {fmtDeviation(n.deviation)}
          </div>
          <div className="sch-c sch-c-status">
            <span className={`status-pill ${SCHEDULE_STATUS_CLASS[n.status]}`}>
              {SCHEDULE_STATUS_LABEL[n.status]}
            </span>
          </div>
          <div className="sch-c sch-c-meta">
            <span className="mono">{fmtRange(n.startPlan, n.endPlan)}</span>
            <span className="mono">
              план {fmtPercent(n.progressPlan)} · факт {fmtPercent(n.progressFact)}
            </span>
            <span className={`mono${n.deviation != null && n.deviation < 0 ? " is-neg" : ""}`}>
              {fmtDeviation(n.deviation)}
            </span>
          </div>
        </div>
        {detailId === n.task.id && <div className="sch-detail-row">{renderDetail(n)}</div>}
      </Fragment>
    );
  }

  const sortArrow = (k: SortKey) => (sortKey === k ? (sortAsc ? " ↑" : " ↓") : "");

  const emptyText = !objectId
    ? "Сначала создайте объект в модуле «Объекты»."
    : loadingTasks || !today
    ? "Загрузка…"
    : tasks.length === 0
    ? "Этапов пока нет — добавьте первый."
    : "Ничего не найдено по заданным условиям.";

  const showRows = !!today && !loadingTasks;

  return (
    <div>
      {banner && (
        <div className="banner show" onClick={() => setBanner(null)} role="status">
          {banner}
        </div>
      )}

      <div className="obj-picker">
        <label htmlFor="sch-object">Объект</label>
        <select
          id="sch-object"
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
        {currentObject && (
          <span className="obj-picker-meta mono">
            {fmtRange(currentObject.start_date, currentObject.end_date_planned)}
          </span>
        )}
      </div>

      <div className="stats">
        <div className="stat-total">
          <span className="n">{showRows ? summary.total : "—"}</span>
          <span className="l">этапов в графике</span>
        </div>
        <div className="chip-row">
          <span className="chip st-good">
            <span className="n">{summary.onTrack}</span> в графике
          </span>
          <span className="chip st-bad">
            <span className="n">{summary.behind}</span> отставание
          </span>
          <span className="chip st-neutral">
            <span className="n">{summary.closed}</span> закрыто
          </span>
        </div>
        <div className="chip-row">
          <span className="chip st-neutral">
            план <span className="n">{fmtPercent(summary.progressPlan)}</span>
          </span>
          <span
            className={`chip ${
              summary.progressFact != null &&
              summary.progressPlan != null &&
              summary.progressFact + 5 < summary.progressPlan
                ? "st-bad"
                : "st-good"
            }`}
          >
            факт <span className="n">{fmtPercent(summary.progressFact)}</span>
          </span>
          {summary.normHours != null && (
            <span className="chip st-neutral">
              <span className="n">{fmtNum(summary.normHours)}</span> н/ч всего
            </span>
          )}
          <span className="chip st-neutral mono">{fmtRange(summary.startPlan, summary.endPlan)}</span>
        </div>
      </div>

      <div className="toolbar">
        <input
          className="search"
          type="text"
          placeholder="Поиск по наименованию этапа…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="filter"
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
        >
          <option value="">Все статусы</option>
          <option value="on_track">В графике</option>
          <option value="behind">Отставание</option>
          <option value="closed">Закрыт</option>
        </select>
        <div className="seg" role="group" aria-label="Вид отображения">
          {(["tree", "table", "gantt"] as ViewMode[]).map((v) => (
            <button
              key={v}
              className={`seg-btn${view === v ? " active" : ""}`}
              onClick={() => changeView(v)}
            >
              {VIEW_LABEL[v]}
            </button>
          ))}
        </div>
        {view === "gantt" && (
          <div className="seg" role="group" aria-label="Масштаб шкалы">
            {(["day", "week", "month"] as GanttScale[]).map((s) => (
              <button
                key={s}
                className={`seg-btn${scale === s ? " active" : ""}`}
                onClick={() => setScale(s)}
              >
                {SCALE_LABEL[s]}
              </button>
            ))}
          </div>
        )}
        <button className="btn btn-primary" onClick={() => openPanel(null)} disabled={!objectId}>
          + Добавить этап
        </button>
      </div>

      {view === "tree" && (
        <div className="sch-wrap">
          <div className="sch-head">
            <div className="sch-c sch-c-name">Этап</div>
            <div className="sch-c sch-c-plan">Сроки план</div>
            <div className="sch-c sch-c-dur">Дней</div>
            <div className="sch-c sch-c-nh">Н/ч</div>
            <div className="sch-c sch-c-fact">Сроки факт</div>
            <div className="sch-c sch-c-pp">% план</div>
            <div className="sch-c sch-c-pf">% факт</div>
            <div className="sch-c sch-c-dev">Откл.</div>
            <div className="sch-c sch-c-status">Статус</div>
          </div>
          {showRows && treeRows.length ? (
            treeRows.map((n) => renderRow(n, "tree"))
          ) : (
            <div className="empty-state">{emptyText}</div>
          )}
        </div>
      )}

      {view === "table" && (
        <div className="sch-wrap">
          <div className="sch-head is-sortable">
            <button className="sch-c sch-c-name" onClick={() => sortBy("name")}>
              Этап{sortArrow("name")}
            </button>
            <button className="sch-c sch-c-plan" onClick={() => sortBy("startPlan")}>
              Сроки план{sortArrow("startPlan")}
            </button>
            <button className="sch-c sch-c-dur" onClick={() => sortBy("duration")}>
              Дней{sortArrow("duration")}
            </button>
            <button className="sch-c sch-c-nh" onClick={() => sortBy("normHours")}>
              Н/ч{sortArrow("normHours")}
            </button>
            <button className="sch-c sch-c-fact" onClick={() => sortBy("endPlan")}>
              Сроки факт{sortArrow("endPlan")}
            </button>
            <button className="sch-c sch-c-pp" onClick={() => sortBy("progressPlan")}>
              % план{sortArrow("progressPlan")}
            </button>
            <button className="sch-c sch-c-pf" onClick={() => sortBy("progressFact")}>
              % факт{sortArrow("progressFact")}
            </button>
            <button className="sch-c sch-c-dev" onClick={() => sortBy("deviation")}>
              Откл.{sortArrow("deviation")}
            </button>
            <button className="sch-c sch-c-status" onClick={() => sortBy("status")}>
              Статус{sortArrow("status")}
            </button>
          </div>
          {showRows && tableRows.length ? (
            tableRows.map((n) => renderRow(n, "table"))
          ) : (
            <div className="empty-state">{emptyText}</div>
          )}
        </div>
      )}

      {view === "gantt" &&
        (showRows && ganttRows.length ? (
          <>
            <ScheduleGantt
              rows={ganttRows}
              today={today as string}
              scale={scale}
              selectedId={detailId}
              onPick={toggleDetail}
            />
            <div className="gantt-legend">
              <span><i className="lg-plan" /> план</span>
              <span><i className="lg-fill" /> выполнено</span>
              <span><i className="lg-fact" /> факт. сроки</span>
              <span><i className="lg-today" /> сегодня</span>
            </div>
            {detailId && nodeById.get(detailId) && (
              <div className="sch-wrap sch-detail-solo">
                {renderDetail(nodeById.get(detailId) as TaskNode)}
              </div>
            )}
          </>
        ) : (
          <div className="sch-wrap">
            <div className="empty-state">{emptyText}</div>
          </div>
        ))}

      <div className={`overlay${panelOpen ? " show" : ""}`} onClick={closePanel} />
      <div className={`panel${panelOpen ? " show" : ""}`}>
        <div className="panel-head">
          <h3>{editingId ? "Изменить этап" : "Новый этап"}</h3>
          <button className="panel-close" aria-label="Закрыть" onClick={closePanel}>
            ✕
          </button>
        </div>
        <div className="panel-body">
          <div className="field">
            <label>
              Наименование этапа <span className="req">*</span>
            </label>
            <input
              type="text"
              placeholder="напр. Монтаж силосного корпуса"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>
          <div className="field-row">
            <div className="field">
              <label>Родительский этап</label>
              <select
                value={form.parentId}
                onChange={(e) => setForm({ ...form, parentId: e.target.value })}
              >
                <option value="">— верхний уровень —</option>
                {parentOptions.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
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

          {editingIsGroup && (
            <p className="hint">
              У этапа есть подэтапы — его сроки, нормочасы и % готовности считаются по ним.
              Поля ниже заблокированы.
            </p>
          )}

          <div className="field-row">
            <div className="field">
              <label>Начало (план)</label>
              <input
                type="date"
                disabled={editingIsGroup}
                value={form.startPlan}
                onChange={(e) => setForm({ ...form, startPlan: e.target.value })}
              />
            </div>
            <div className="field">
              <label>Окончание (план)</label>
              <input
                type="date"
                disabled={editingIsGroup}
                value={form.endPlan}
                onChange={(e) => setForm({ ...form, endPlan: e.target.value })}
              />
            </div>
          </div>
          <div className="field-row">
            <div className="field">
              <label>Начало (факт)</label>
              <input
                type="date"
                disabled={editingIsGroup}
                value={form.startFact}
                onChange={(e) => setForm({ ...form, startFact: e.target.value })}
              />
            </div>
            <div className="field">
              <label>Окончание (факт)</label>
              <input
                type="date"
                disabled={editingIsGroup}
                value={form.endFact}
                onChange={(e) => setForm({ ...form, endFact: e.target.value })}
              />
            </div>
          </div>
          <div className="field-row">
            <div className="field">
              <label>Нормочасы на работу</label>
              <input
                type="number"
                min={0}
                step="0.5"
                placeholder="0"
                disabled={editingIsGroup}
                value={form.normHours}
                onChange={(e) => setForm({ ...form, normHours: e.target.value })}
              />
            </div>
            <div className="field">
              <label>% готовности факт</label>
              <input
                type="number"
                min={0}
                max={100}
                step="1"
                placeholder="0"
                disabled={editingIsGroup}
                value={form.progressFact}
                onChange={(e) => setForm({ ...form, progressFact: e.target.value })}
              />
            </div>
          </div>

          <div className="calc-box">
            <h4>Расчёт</h4>
            <dl>
              <dt>Длительность (план)</dt>
              <dd className="mono">
                {formPreview.duration ? `${formPreview.duration} дн.` : "—"}
              </dd>
              <dt>% готовности план</dt>
              <dd className="mono">{fmtPercent(formPreview.progressPlan)}</dd>
              <dt>Отклонение план-факт</dt>
              <dd className="mono">{fmtDeviation(formPreview.deviation)}</dd>
            </dl>
            <p className="hint">
              Считается автоматически по датам и % факта, в БД не хранится.
            </p>
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

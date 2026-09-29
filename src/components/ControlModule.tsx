"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { dbErrorText, needsSchemaSetup } from "@/lib/dbError";
import { bucketMissing } from "@/lib/schemaPatch";
import {
  ConstructionObject,
  HistoryEntry,
  IssueStatus,
  ISSUE_STATUS_CLASS,
  ISSUE_STATUS_LABEL,
  PHOTO_BUCKET,
  PhotoReport,
  PhotoRef,
  ScheduleTask,
  SiteIssue,
} from "@/lib/types";
import { buildTree, flattenTree } from "@/lib/schedule";
import { compressImage, randomStorageName } from "@/lib/image";
import { fmtDate, fmtDateTime, fmtPercent, plural } from "@/lib/format";
import { OBJECT_KEY, readSetting, useToday, writeSetting } from "@/lib/useClient";
import SchemaSetup from "@/components/SchemaSetup";

/** Выбранный объект — общий для всех вкладок: выбрали на одной, открыт и на остальных. */
const LS_OBJECT_KEY = OBJECT_KEY;
const DISCREPANCY_THRESHOLD = 10;

type View = "photos" | "issues";
type IssueFilter = "unresolved" | "overdue" | "all" | IssueStatus;

function publicPhotoUrl(path: string): string {
  return supabase.storage.from(PHOTO_BUCKET).getPublicUrl(path).data.publicUrl;
}

/* ============================== Фотоотчёты ============================== */

interface StagedFile {
  key: string;
  file: File;
  previewUrl: string;
}

interface ReportForm {
  reportDate: string;
  taskId: string;
  progressPercent: string;
  comment: string;
}

function emptyReportForm(today: string | null): ReportForm {
  return { reportDate: today || "", taskId: "", progressPercent: "", comment: "" };
}

/* ============================== Замечания ============================== */

interface IssueForm {
  description: string;
  taskId: string;
  responsible: string;
  dueDate: string;
}

const EMPTY_ISSUE_FORM: IssueForm = { description: "", taskId: "", responsible: "", dueDate: "" };

function issueToForm(i: SiteIssue | null): IssueForm {
  if (!i) return { ...EMPTY_ISSUE_FORM };
  return {
    description: i.description,
    taskId: i.task_id || "",
    responsible: i.responsible || "",
    dueDate: i.due_date || "",
  };
}

export default function ControlModule() {
  const today = useToday();

  const [objects, setObjects] = useState<ConstructionObject[]>([]);
  const [objectId, setObjectId] = useState<string>("");
  const [loadingObjects, setLoadingObjects] = useState(true);
  const [loadingData, setLoadingData] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [schemaMissing, setSchemaMissing] = useState(false);
  const [photoBucketMissing, setPhotoBucketMissing] = useState(false);
  const [view, setView] = useState<View>("photos");

  const [tasks, setTasks] = useState<ScheduleTask[]>([]);
  const [reports, setReports] = useState<PhotoReport[]>([]);
  const [issues, setIssues] = useState<SiteIssue[]>([]);

  // ---- фотоотчёты ----
  const [reportPanelOpen, setReportPanelOpen] = useState(false);
  const [editingReportId, setEditingReportId] = useState<string | null>(null);
  const [reportForm, setReportForm] = useState<ReportForm>(emptyReportForm(null));
  const [existingPhotos, setExistingPhotos] = useState<PhotoRef[]>([]);
  const [removedPaths, setRemovedPaths] = useState<string[]>([]);
  const [stagedFiles, setStagedFiles] = useState<StagedFile[]>([]);
  const [reportSaving, setReportSaving] = useState(false);
  const [reportPendingDelete, setReportPendingDelete] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // ---- замечания ----
  const [issueFilter, setIssueFilter] = useState<IssueFilter>("unresolved");
  const [issuePanelOpen, setIssuePanelOpen] = useState(false);
  const [editingIssueId, setEditingIssueId] = useState<string | null>(null);
  const [issueForm, setIssueForm] = useState<IssueForm>(EMPTY_ISSUE_FORM);
  const [issueSaving, setIssueSaving] = useState(false);
  const [issueDetailId, setIssueDetailId] = useState<string | null>(null);
  const [issuePendingDeleteId, setIssuePendingDeleteId] = useState<string | null>(null);

  const loadObjects = useCallback(async () => {
    setLoadingObjects(true);
    const { data, error } = await supabase
      .from("objects")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) {
      setBanner(dbErrorText(error, "Не удалось загрузить объекты"));
      setLoadingObjects(false);
      return;
    }
    const list = (data as ConstructionObject[]) || [];
    setObjects(list);
    const saved = readSetting(LS_OBJECT_KEY) || "";
    setObjectId(list.find((o) => o.id === saved)?.id || list[0]?.id || "");
    setLoadingObjects(false);
  }, []);

  // При быстром переключении объектов запоздавший ответ по прежнему объекту отбрасывается.
  const objectIdRef = useRef(objectId);
  useEffect(() => {
    objectIdRef.current = objectId;
  }, [objectId]);

  const loadObjectData = useCallback(async (id: string) => {
    if (!id) {
      setTasks([]);
      setReports([]);
      setIssues([]);
      return;
    }
    setLoadingData(true);
    const [taskRes, repRes, issueRes] = await Promise.all([
      supabase.from("schedule_tasks").select("*").eq("object_id", id).order("sort_order"),
      supabase.from("photo_reports").select("*").eq("object_id", id).order("report_date", { ascending: false }),
      supabase.from("site_issues").select("*").eq("object_id", id),
    ]);
    if (id !== objectIdRef.current) return;
    const missing = needsSchemaSetup(taskRes.error) || needsSchemaSetup(repRes.error) || needsSchemaSetup(issueRes.error);
    setSchemaMissing(missing);
    if (taskRes.error) setBanner(dbErrorText(taskRes.error, "Не удалось загрузить график"));
    else if (repRes.error && !needsSchemaSetup(repRes.error)) setBanner(dbErrorText(repRes.error, "Не удалось загрузить фотоотчёты"));
    else if (issueRes.error && !needsSchemaSetup(issueRes.error)) setBanner(dbErrorText(issueRes.error, "Не удалось загрузить замечания"));

    setTasks((taskRes.data as ScheduleTask[]) || []);
    setReports((repRes.data as PhotoReport[]) || []);
    setIssues((issueRes.data as SiteIssue[]) || []);
    setLoadingData(false);
  }, []);

  const checkPhotoBucket = useCallback(async () => {
    setPhotoBucketMissing(await bucketMissing(PHOTO_BUCKET));
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- состояние ставится после await, не синхронно
    loadObjects();
    // Бакет один на весь проект — проверяем независимо от выбранного объекта,
    // иначе о его отсутствии пользователь узнает только после неудачной загрузки фото.
    checkPhotoBucket();
  }, [loadObjects, checkPhotoBucket]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- состояние ставится после await, не синхронно
    loadObjectData(objectId);
  }, [objectId, loadObjectData]);

  function changeObject(id: string) {
    setObjectId(id);
    setIssueDetailId(null);
    writeSetting(LS_OBJECT_KEY, id);
  }

  const tree = useMemo(() => (today ? buildTree(tasks, today) : []), [tasks, today]);
  const leaves = useMemo(() => flattenTree(tree).filter((n) => !n.isGroup), [tree]);

  function taskNameById(id: string | null): string {
    if (!id) return "—";
    return leaves.find((n) => n.task.id === id)?.task.name || "этап удалён";
  }

  /* ------------------------------ Фотоотчёты: производные ------------------------------ */

  const reportsSorted = useMemo(
    () => reports.slice().sort((a, b) => b.report_date.localeCompare(a.report_date) || b.created_at.localeCompare(a.created_at)),
    [reports]
  );

  const latestByTask = useMemo(() => {
    const m = new Map<string, PhotoReport>();
    reports.forEach((r) => {
      if (!r.task_id || r.progress_percent === null || r.progress_percent === undefined) return;
      const cur = m.get(r.task_id);
      if (!cur || r.report_date > cur.report_date || (r.report_date === cur.report_date && r.created_at > cur.created_at)) {
        m.set(r.task_id, r);
      }
    });
    return m;
  }, [reports]);

  const discrepancyIds = useMemo(() => {
    const s = new Set<string>();
    latestByTask.forEach((r, taskId) => {
      const node = leaves.find((n) => n.task.id === taskId);
      if (!node) return;
      const diff = (r.progress_percent as number) - node.progressFact;
      if (Math.abs(diff) > DISCREPANCY_THRESHOLD) s.add(r.id);
    });
    return s;
  }, [latestByTask, leaves]);

  const photoStats = useMemo(() => {
    const photosCount = reports.reduce((s, r) => s + (r.photos?.length || 0), 0);
    return { reportsCount: reports.length, photosCount, discrepancyCount: discrepancyIds.size };
  }, [reports, discrepancyIds]);

  /* ------------------------------ Фотоотчёты: панель ------------------------------ */

  function resetStaged() {
    stagedFiles.forEach((f) => URL.revokeObjectURL(f.previewUrl));
    setStagedFiles([]);
  }

  function openReportPanel(id: string | null) {
    resetStaged();
    setRemovedPaths([]);
    setEditingReportId(id);
    const r = id ? reports.find((x) => x.id === id) || null : null;
    if (r) {
      setReportForm({
        reportDate: r.report_date,
        taskId: r.task_id || "",
        progressPercent: r.progress_percent != null ? String(r.progress_percent) : "",
        comment: r.comment || "",
      });
      setExistingPhotos(r.photos || []);
    } else {
      setReportForm(emptyReportForm(today));
      setExistingPhotos([]);
    }
    setReportPendingDelete(false);
    setReportPanelOpen(true);
  }
  function closeReportPanel() {
    resetStaged();
    setReportPanelOpen(false);
    setEditingReportId(null);
  }

  function onTaskPickReport(taskId: string) {
    setReportForm((f) => {
      const node = leaves.find((n) => n.task.id === taskId);
      return { ...f, taskId, progressPercent: f.progressPercent || (node ? String(node.progressFact) : "") };
    });
  }

  function onFilesChosen(files: FileList | null) {
    if (!files || !files.length) return;
    const next: StagedFile[] = Array.from(files).map((file) => ({
      key: `${Date.now()}_${Math.random()}`,
      file,
      previewUrl: URL.createObjectURL(file),
    }));
    setStagedFiles((cur) => [...cur, ...next]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function removeStaged(key: string) {
    setStagedFiles((cur) => {
      const found = cur.find((f) => f.key === key);
      if (found) URL.revokeObjectURL(found.previewUrl);
      return cur.filter((f) => f.key !== key);
    });
  }

  function removeExisting(path: string) {
    setExistingPhotos((cur) => cur.filter((p) => p.path !== path));
    setRemovedPaths((cur) => [...cur, path]);
  }

  async function saveReport() {
    if (!reportForm.reportDate) {
      setBanner("Укажите дату съёмки.");
      return;
    }
    if (existingPhotos.length + stagedFiles.length === 0) {
      setBanner("Добавьте хотя бы одно фото — отчёт без фото не сохраняется.");
      return;
    }
    const pct = reportForm.progressPercent === "" ? null : Number(reportForm.progressPercent);
    if (pct !== null && (isNaN(pct) || pct < 0 || pct > 100)) {
      setBanner("% выполненного объёма — число от 0 до 100.");
      return;
    }
    setBanner(null);
    setReportSaving(true);

    let uploaded: PhotoRef[] = [];
    try {
      uploaded = await Promise.all(
        stagedFiles.map(async (sf) => {
          const blob = await compressImage(sf.file);
          const name = randomStorageName(sf.file.name);
          const path = `${objectId}/${name}`;
          const { error } = await supabase.storage.from(PHOTO_BUCKET).upload(path, blob, { contentType: "image/jpeg" });
          if (error) throw error;
          return { path, name: sf.file.name };
        })
      );
    } catch (e) {
      setBanner(`Не удалось загрузить фото: ${e instanceof Error ? e.message : String(e)}`);
      setReportSaving(false);
      return;
    }

    const now = new Date().toISOString();
    const allPhotos = [...existingPhotos, ...uploaded];
    const payload = {
      object_id: objectId,
      task_id: reportForm.taskId || null,
      report_date: reportForm.reportDate,
      progress_percent: pct,
      comment: reportForm.comment.trim() || null,
      photos: allPhotos,
      updated_at: now,
    };

    if (editingReportId) {
      const old = reports.find((x) => x.id === editingReportId) || null;
      const parts: string[] = [];
      if (old?.report_date !== payload.report_date) parts.push(`Дата: ${fmtDate(old?.report_date || null)} → ${fmtDate(payload.report_date)}`);
      if ((old?.progress_percent ?? null) !== pct) parts.push(`% по фото: ${old?.progress_percent ?? "—"} → ${pct ?? "—"}`);
      if ((old?.photos?.length || 0) !== allPhotos.length) parts.push(`Фото: ${old?.photos?.length || 0} → ${allPhotos.length}`);
      const history: HistoryEntry[] = [...(old?.history || []), { at: now, text: parts.length ? parts.join("; ") : "Отчёт сохранён без изменений" }];
      const { error } = await supabase.from("photo_reports").update({ ...payload, history }).eq("id", editingReportId);
      if (error) {
        setBanner(dbErrorText(error, "Не удалось сохранить отчёт"));
        // Запись не обновилась — только что загруженные фото ни на что не сослались, стираем их,
        // чтобы не плодить файлы-сироты в хранилище (уже существовавшие фото не трогаем).
        if (uploaded.length) await supabase.storage.from(PHOTO_BUCKET).remove(uploaded.map((p) => p.path));
        setReportSaving(false);
        return;
      }
      if (removedPaths.length) await supabase.storage.from(PHOTO_BUCKET).remove(removedPaths);
      closeReportPanel();
      await loadObjectData(objectId);
    } else {
      const { error } = await supabase
        .from("photo_reports")
        .insert({ ...payload, created_at: now, history: [{ at: now, text: "Фотоотчёт создан" }] });
      if (error) {
        setBanner(dbErrorText(error, "Не удалось создать отчёт"));
        // Запись не создалась — загруженные фото стираем, а не оставляем сиротами в хранилище.
        if (uploaded.length) await supabase.storage.from(PHOTO_BUCKET).remove(uploaded.map((p) => p.path));
        setReportSaving(false);
        return;
      }
      closeReportPanel();
      await loadObjectData(objectId);
    }
    setReportSaving(false);
  }

  async function deleteReport(id: string) {
    const r = reports.find((x) => x.id === id);
    // Сначала удаляем запись в базе — источник истины; файлы в хранилище чистим только
    // после успеха, чтобы неудачное удаление строки не оставило акт без фото безвозвратно.
    const { error } = await supabase.from("photo_reports").delete().eq("id", id);
    if (error) {
      setBanner(dbErrorText(error, "Не удалось удалить отчёт"));
      setReportPendingDelete(false);
      return;
    }
    if (r?.photos?.length) {
      await supabase.storage.from(PHOTO_BUCKET).remove(r.photos.map((p) => p.path));
    }
    closeReportPanel();
    await loadObjectData(objectId);
    setReportPendingDelete(false);
  }

  /* ------------------------------ Замечания: производные ------------------------------ */

  const issuesFiltered = useMemo(() => {
    if (!today) return issues;
    return issues.filter((i) => {
      const overdue = i.status !== "resolved" && !!i.due_date && i.due_date < today;
      if (issueFilter === "unresolved") return i.status !== "resolved";
      if (issueFilter === "overdue") return overdue;
      if (issueFilter === "all") return true;
      return i.status === issueFilter;
    });
  }, [issues, issueFilter, today]);

  const issuesSorted = useMemo(() => {
    if (!today) return issuesFiltered;
    return issuesFiltered.slice().sort((a, b) => {
      const aOver = a.status !== "resolved" && !!a.due_date && a.due_date < today;
      const bOver = b.status !== "resolved" && !!b.due_date && b.due_date < today;
      if (aOver !== bOver) return aOver ? -1 : 1;
      const aRes = a.status === "resolved";
      const bRes = b.status === "resolved";
      if (aRes !== bRes) return aRes ? 1 : -1;
      if (a.due_date && b.due_date && a.due_date !== b.due_date) return a.due_date.localeCompare(b.due_date);
      if (a.due_date && !b.due_date) return -1;
      if (!a.due_date && b.due_date) return 1;
      return b.created_at.localeCompare(a.created_at);
    });
  }, [issuesFiltered, today]);

  const issueStats = useMemo(() => {
    const overdue = today ? issues.filter((i) => i.status !== "resolved" && !!i.due_date && i.due_date < today).length : 0;
    const open = issues.filter((i) => i.status !== "resolved").length;
    return { overdue, open, total: issues.length };
  }, [issues, today]);

  /* ------------------------------ Замечания: панель ------------------------------ */

  function openIssuePanel(id: string | null) {
    setEditingIssueId(id);
    const i = id ? issues.find((x) => x.id === id) || null : null;
    setIssueForm(issueToForm(i));
    setIssuePanelOpen(true);
  }
  function closeIssuePanel() {
    setIssuePanelOpen(false);
    setEditingIssueId(null);
  }

  async function saveIssue() {
    if (!issueForm.description.trim()) {
      setBanner("Опишите замечание.");
      return;
    }
    setBanner(null);
    setIssueSaving(true);
    const now = new Date().toISOString();
    const payload = {
      object_id: objectId,
      task_id: issueForm.taskId || null,
      description: issueForm.description.trim(),
      responsible: issueForm.responsible.trim() || null,
      due_date: issueForm.dueDate || null,
      updated_at: now,
    };

    if (editingIssueId) {
      const old = issues.find((x) => x.id === editingIssueId) || null;
      const parts: string[] = [];
      if (old?.description !== payload.description) parts.push("Описание изменено");
      if ((old?.responsible || "") !== (payload.responsible || "")) parts.push(`Ответственный: ${old?.responsible || "—"} → ${payload.responsible || "—"}`);
      if ((old?.due_date || "") !== (payload.due_date || "")) parts.push(`Срок: ${fmtDate(old?.due_date || null)} → ${fmtDate(payload.due_date)}`);
      const history: HistoryEntry[] = [...(old?.history || []), { at: now, text: parts.length ? parts.join("; ") : "Замечание сохранено без изменений" }];
      const { error } = await supabase.from("site_issues").update({ ...payload, history }).eq("id", editingIssueId);
      if (error) setBanner(dbErrorText(error, "Не удалось сохранить замечание"));
      else {
        closeIssuePanel();
        await loadObjectData(objectId);
      }
    } else {
      const { error } = await supabase.from("site_issues").insert({
        ...payload,
        status: "open",
        created_at: now,
        history: [{ at: now, text: "Замечание зарегистрировано" }],
      });
      if (error) setBanner(dbErrorText(error, "Не удалось добавить замечание"));
      else {
        closeIssuePanel();
        await loadObjectData(objectId);
      }
    }
    setIssueSaving(false);
  }

  async function deleteIssue(id: string) {
    const { error } = await supabase.from("site_issues").delete().eq("id", id);
    if (error) setBanner(dbErrorText(error, "Не удалось удалить замечание"));
    else {
      if (issueDetailId === id) setIssueDetailId(null);
      await loadObjectData(objectId);
    }
    setIssuePendingDeleteId(null);
  }

  async function issueStatusChange(issue: SiteIssue, status: IssueStatus) {
    const now = new Date().toISOString();
    const resolvedAt = status === "resolved" ? today : null;
    const text =
      status === "resolved"
        ? `Устранено${resolvedAt && issue.due_date && resolvedAt > issue.due_date ? " (позже срока)" : ""}`
        : status === "in_progress"
        ? "Взято в работу"
        : "Открыто заново";
    const history: HistoryEntry[] = [...(issue.history || []), { at: now, text }];
    const { error } = await supabase
      .from("site_issues")
      .update({ status, resolved_at: resolvedAt, history, updated_at: now })
      .eq("id", issue.id);
    if (error) setBanner(dbErrorText(error, "Не удалось обновить замечание"));
    else await loadObjectData(objectId);
  }

  /* ------------------------------ Рендер ------------------------------ */

  const selectedObject = objects.find((o) => o.id === objectId) || null;

  return (
    <div>
      {banner && (
        <div className="banner show" onClick={() => setBanner(null)} role="status">
          {banner}
        </div>
      )}
      {(schemaMissing || photoBucketMissing) && (
        <SchemaSetup
          onRecheck={() => {
            loadObjectData(objectId);
            checkPhotoBucket();
          }}
        />
      )}

      <div className="obj-picker">
        <label htmlFor="control-object">Объект</label>
        <select
          id="control-object"
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
        {selectedObject && <span className="obj-picker-meta">{selectedObject.address}</span>}
      </div>

      <div className="toolbar">
        <div className="seg" role="tablist" aria-label="Раздел контроля стройки">
          <button className={`seg-btn${view === "photos" ? " active" : ""}`} onClick={() => setView("photos")}>
            Фотоотчёты
          </button>
          <button className={`seg-btn${view === "issues" ? " active" : ""}`} onClick={() => setView("issues")}>
            Замечания
          </button>
        </div>
        {view === "photos" && (
          <button className="btn btn-primary" onClick={() => openReportPanel(null)} disabled={!objectId}>
            + Фотоотчёт
          </button>
        )}
        {view === "issues" && (
          <button className="btn btn-primary" onClick={() => openIssuePanel(null)} disabled={!objectId}>
            + Замечание
          </button>
        )}
      </div>

      {!objectId ? (
        <div className="empty-state">Сначала создайте объект в модуле «Объекты».</div>
      ) : loadingData || !today ? (
        <div className="empty-state">Загрузка…</div>
      ) : view === "photos" ? (
        <>
          <div className="stats">
            <div className="stat-total">
              <span className="n">{photoStats.reportsCount}</span>
              <span className="l">{plural(photoStats.reportsCount, "отчёт", "отчёта", "отчётов")}</span>
            </div>
            <div className="chip-row">
              <span className="chip st-neutral">
                <span className="n">{photoStats.photosCount}</span> {plural(photoStats.photosCount, "фото", "фото", "фото")}
              </span>
              {photoStats.discrepancyCount > 0 && (
                <span className="chip st-bad">
                  <span className="n">{photoStats.discrepancyCount}</span> расхождение с графиком
                </span>
              )}
            </div>
          </div>

          {reportsSorted.length === 0 ? (
            <div className="empty-state">Фотоотчётов пока нет — добавьте первый.</div>
          ) : (
            <div className="photo-grid">
              {reportsSorted.map((r) => {
                const cover = r.photos?.[0];
                const extra = (r.photos?.length || 0) - 1;
                const hasDiscrepancy = discrepancyIds.has(r.id);
                return (
                  <div key={r.id} className="photo-card" onClick={() => openReportPanel(r.id)}>
                    <div className="photo-cover">
                      {cover ? (
                        // eslint-disable-next-line @next/next/no-img-element -- превью из Supabase Storage, домен неизвестен заранее
                        <img src={publicPhotoUrl(cover.path)} alt={cover.name} />
                      ) : (
                        <div className="empty-state" style={{ padding: 0 }}>
                          нет фото
                        </div>
                      )}
                      {extra > 0 && <span className="photo-count-badge">+{extra} фото</span>}
                    </div>
                    <div className="photo-card-body">
                      <div className="photo-card-title">
                        <span>{fmtDate(r.report_date)}</span>
                        {r.progress_percent != null && <span className="mono">{fmtPercent(r.progress_percent)}</span>}
                      </div>
                      <div className="photo-card-sub">{taskNameById(r.task_id)}</div>
                      {hasDiscrepancy && <span className="chip st-bad">расхождение с графиком &gt;{DISCREPANCY_THRESHOLD} п.п.</span>}
                      {r.comment && <div className="photo-card-comment">{r.comment}</div>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="stats">
            <div className="stat-total">
              <span className="n">{issueStats.open}</span>
              <span className="l">{plural(issueStats.open, "неустранённое", "неустранённых", "неустранённых")}</span>
            </div>
            <div className="chip-row">
              {issueStats.overdue > 0 && (
                <span className="chip st-bad">
                  <span className="n">{issueStats.overdue}</span> просрочено
                </span>
              )}
              <span className="chip st-neutral">
                <span className="n">{issueStats.total}</span> всего
              </span>
            </div>
          </div>

          <div className="toolbar" style={{ padding: "0 0 14px" }}>
            <select className="filter" value={issueFilter} onChange={(e) => setIssueFilter(e.target.value as IssueFilter)}>
              <option value="unresolved">Неустранённые</option>
              <option value="overdue">Просроченные</option>
              <option value="open">Открыто</option>
              <option value="in_progress">В работе</option>
              <option value="resolved">Устранено</option>
              <option value="all">Все</option>
            </select>
          </div>

          {issuesSorted.length === 0 ? (
            <div className="empty-state">Замечаний в этом разделе нет.</div>
          ) : (
            <ul className="accept-list">
              {issuesSorted.map((i) => {
                const overdue = i.status !== "resolved" && !!i.due_date && i.due_date < today;
                const isOpen = issueDetailId === i.id;
                const late = i.resolved_at && i.due_date && i.resolved_at > i.due_date;
                return (
                  <li key={i.id} className="accept-item">
                    <div className="accept-row" onClick={() => setIssueDetailId(isOpen ? null : i.id)}>
                      <div className="accept-main">
                        <div className="accept-name">{i.description}</div>
                        <div className="accept-sub">
                          {taskNameById(i.task_id)} {i.responsible ? `· ${i.responsible}` : ""} {i.due_date ? `· срок ${fmtDate(i.due_date)}` : ""}
                        </div>
                      </div>
                      <div className="accept-meta">
                        {overdue && <span className="chip st-bad">просрочено</span>}
                        {late && <span className="chip st-warn">позже срока</span>}
                        <span className={`status-pill ${ISSUE_STATUS_CLASS[i.status]}`}>{ISSUE_STATUS_LABEL[i.status]}</span>
                      </div>
                    </div>
                    {isOpen && (
                      <div className="accept-form">
                        <div className="accept-actions">
                          {issuePendingDeleteId === i.id ? (
                            <button className="btn btn-sm btn-danger" onClick={() => deleteIssue(i.id)}>
                              Точно удалить?
                            </button>
                          ) : (
                            <button className="btn btn-sm btn-ghost" onClick={() => setIssuePendingDeleteId(i.id)}>
                              Удалить
                            </button>
                          )}
                          <button className="btn btn-sm btn-ghost" onClick={() => openIssuePanel(i.id)}>
                            Изменить
                          </button>
                          {i.status === "open" && (
                            <button className="btn btn-sm btn-ghost" onClick={() => issueStatusChange(i, "in_progress")}>
                              Взять в работу
                            </button>
                          )}
                          {i.status !== "resolved" && (
                            <button className="btn btn-sm btn-primary" onClick={() => issueStatusChange(i, "resolved")}>
                              Устранено
                            </button>
                          )}
                          {i.status === "resolved" && (
                            <button className="btn btn-sm btn-ghost" onClick={() => issueStatusChange(i, "open")}>
                              Открыть заново
                            </button>
                          )}
                        </div>
                        {i.history && i.history.length > 0 && (
                          <ul className="history-list">
                            {i.history
                              .slice()
                              .reverse()
                              .map((h, idx) => (
                                <li key={idx}>
                                  <time>{fmtDateTime(h.at)}</time>
                                  {h.text}
                                </li>
                              ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}

      {/* ---- Панель фотоотчёта ---- */}
      <div className={`overlay${reportPanelOpen ? " show" : ""}`} onClick={closeReportPanel} />
      <div className={`panel${reportPanelOpen ? " show" : ""}`}>
        <div className="panel-head">
          <h3>{editingReportId ? "Фотоотчёт" : "Новый фотоотчёт"}</h3>
          <button className="panel-close" aria-label="Закрыть" onClick={closeReportPanel}>
            ✕
          </button>
        </div>
        <div className="panel-body">
          <div className="field-row">
            <div className="field">
              <label>
                Дата съёмки <span className="req">*</span>
              </label>
              <input type="date" value={reportForm.reportDate} onChange={(e) => setReportForm({ ...reportForm, reportDate: e.target.value })} />
            </div>
            <div className="field">
              <label>% выполненного объёма</label>
              <input
                type="number"
                min={0}
                max={100}
                value={reportForm.progressPercent}
                onChange={(e) => setReportForm({ ...reportForm, progressPercent: e.target.value })}
              />
            </div>
          </div>
          <div className="field">
            <label>Этап графика</label>
            <select value={reportForm.taskId} onChange={(e) => onTaskPickReport(e.target.value)}>
              <option value="">— без привязки —</option>
              {leaves.map((n) => (
                <option key={n.task.id} value={n.task.id}>
                  {n.task.name}
                </option>
              ))}
            </select>
            <p className="hint">Выбор подставит текущий факт этапа в поле % выше, если оно ещё пустое.</p>
          </div>
          <div className="field">
            <label>Комментарий</label>
            <textarea value={reportForm.comment} onChange={(e) => setReportForm({ ...reportForm, comment: e.target.value })} />
          </div>
          <div className="field">
            <label>
              Фото <span className="req">*</span>
            </label>
            <div className="photo-thumbs">
              {existingPhotos.map((p) => (
                <div className="photo-thumb" key={p.path}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- превью из Supabase Storage */}
                  <img src={publicPhotoUrl(p.path)} alt={p.name} />
                  <button
                    className="photo-thumb-remove"
                    type="button"
                    onClick={() => removeExisting(p.path)}
                    aria-label="Убрать фото"
                  >
                    ✕
                  </button>
                </div>
              ))}
              {stagedFiles.map((f) => (
                <div className="photo-thumb" key={f.key}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- локальное превью до загрузки */}
                  <img src={f.previewUrl} alt={f.file.name} />
                  <button className="photo-thumb-remove" type="button" onClick={() => removeStaged(f.key)} aria-label="Убрать фото">
                    ✕
                  </button>
                </div>
              ))}
              <button type="button" className="photo-add-btn" onClick={() => fileInputRef.current?.click()} aria-label="Добавить фото">
                +
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                style={{ display: "none" }}
                onChange={(e) => onFilesChosen(e.target.files)}
              />
            </div>
            <p className="hint">Фото сжимаются в браузере до 1920 px по длинной стороне перед загрузкой.</p>
          </div>

          {editingReportId && (
            <>
              {reports.find((r) => r.id === editingReportId)?.history?.length ? (
                <ul className="history-list">
                  {reports
                    .find((r) => r.id === editingReportId)!
                    .history.slice()
                    .reverse()
                    .map((h, i) => (
                      <li key={i}>
                        <time>{fmtDateTime(h.at)}</time>
                        {h.text}
                      </li>
                    ))}
                </ul>
              ) : null}
            </>
          )}
        </div>
        <div className="panel-foot">
          {editingReportId &&
            (reportPendingDelete ? (
              <button className="btn btn-danger" onClick={() => deleteReport(editingReportId)}>
                Точно удалить?
              </button>
            ) : (
              <button className="btn btn-ghost" onClick={() => setReportPendingDelete(true)}>
                Удалить
              </button>
            ))}
          <button className="btn btn-ghost" onClick={closeReportPanel}>
            Отмена
          </button>
          <button className="btn btn-primary" onClick={saveReport} disabled={reportSaving}>
            {reportSaving ? "Сохранение…" : "Сохранить"}
          </button>
        </div>
      </div>

      {/* ---- Панель замечания ---- */}
      <div className={`overlay${issuePanelOpen ? " show" : ""}`} onClick={closeIssuePanel} />
      <div className={`panel${issuePanelOpen ? " show" : ""}`}>
        <div className="panel-head">
          <h3>{editingIssueId ? "Изменить замечание" : "Новое замечание"}</h3>
          <button className="panel-close" aria-label="Закрыть" onClick={closeIssuePanel}>
            ✕
          </button>
        </div>
        <div className="panel-body">
          <div className="field">
            <label>
              Описание <span className="req">*</span>
            </label>
            <textarea
              placeholder="напр. Не закрыты монтажные проёмы в перекрытии оси 3"
              value={issueForm.description}
              onChange={(e) => setIssueForm({ ...issueForm, description: e.target.value })}
            />
          </div>
          <div className="field">
            <label>Этап графика</label>
            <select value={issueForm.taskId} onChange={(e) => setIssueForm({ ...issueForm, taskId: e.target.value })}>
              <option value="">— без привязки —</option>
              {leaves.map((n) => (
                <option key={n.task.id} value={n.task.id}>
                  {n.task.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field-row">
            <div className="field">
              <label>Ответственный</label>
              <input type="text" value={issueForm.responsible} onChange={(e) => setIssueForm({ ...issueForm, responsible: e.target.value })} />
            </div>
            <div className="field">
              <label>Срок устранения</label>
              <input type="date" value={issueForm.dueDate} onChange={(e) => setIssueForm({ ...issueForm, dueDate: e.target.value })} />
            </div>
          </div>
        </div>
        <div className="panel-foot">
          <button className="btn btn-ghost" onClick={closeIssuePanel}>
            Отмена
          </button>
          <button className="btn btn-primary" onClick={saveIssue} disabled={issueSaving}>
            {issueSaving ? "Сохранение…" : "Сохранить"}
          </button>
        </div>
      </div>
    </div>
  );
}

"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { dbErrorText, needsSchemaSetup } from "@/lib/dbError";
import {
  AcceptanceAct,
  AcceptanceStatus,
  ACCEPTANCE_STATUS_CLASS,
  ACCEPTANCE_STATUS_LABEL,
  CertDocType,
  CERT_DOC_TYPE_LABEL,
  ConstructionObject,
  HistoryEntry,
  MaterialCertificate,
  ScheduleTask,
  SupplyRequest,
  SUPPLY_STATUS_LABEL,
  WorkLogEntry,
} from "@/lib/types";
import { buildTree, flattenTree, parseDay, TaskNode } from "@/lib/schedule";
import { ACCEPTANCE_OVERDUE_DAYS } from "@/lib/portfolioHealth";
import { fmtDate, fmtDateTime, fmtMoney, plural } from "@/lib/format";
import { OBJECT_KEY, readSetting, useToday } from "@/lib/useClient";
import SchemaSetup from "@/components/SchemaSetup";
import CurrentObject from "@/components/CurrentObject";
import { DOUBLE_TAP_HINT, useDoubleTap } from "@/lib/useDoubleTap";

/** Выбранный объект — общий для всех вкладок: выбрали на одной, открыт и на остальных. */
const LS_OBJECT_KEY = OBJECT_KEY;
const MS_PER_DAY = 86_400_000;

type View = "acts" | "log" | "certs";

function daysBetween(from: string | null, to: string | null): number | null {
  const a = parseDay(from);
  const b = parseDay(to);
  if (a === null || b === null) return null;
  return Math.round((b - a) / MS_PER_DAY);
}

/* ============================== Акты скрытых работ ============================== */

interface ActForm {
  status: AcceptanceStatus;
  actNumber: string;
  actDate: string;
  amount: string;
  description: string;
  responsible: string;
}

const EMPTY_ACT_FORM: ActForm = {
  status: "draft",
  actNumber: "",
  actDate: "",
  amount: "",
  description: "",
  responsible: "",
};

interface ActRow {
  node: TaskNode;
  act: AcceptanceAct | null;
  daysWaiting: number | null;
}

/* ============================== Журналы работ ============================== */

interface LogForm {
  entryDate: string;
  taskId: string;
  weather: string;
  crew: string;
  content: string;
}

function emptyLogForm(today: string | null): LogForm {
  return { entryDate: today || "", taskId: "", weather: "", crew: "", content: "" };
}

const LOG_FIELD_LABEL: Record<keyof LogForm, string> = {
  entryDate: "Дата",
  taskId: "Этап",
  weather: "Погода",
  crew: "Бригада",
  content: "Содержание",
};

function logToForm(e: WorkLogEntry | null, today: string | null): LogForm {
  if (!e) return emptyLogForm(today);
  return {
    entryDate: e.entry_date,
    taskId: e.task_id || "",
    weather: e.weather || "",
    crew: e.crew || "",
    content: e.content,
  };
}

/* ============================== Сертификаты и паспорта ============================== */

interface CertForm {
  materialName: string;
  docType: CertDocType;
  docNumber: string;
  docDate: string;
  supplier: string;
  deliveryId: string;
}

const EMPTY_CERT_FORM: CertForm = {
  materialName: "",
  docType: "certificate",
  docNumber: "",
  docDate: "",
  supplier: "",
  deliveryId: "",
};

const CERT_FIELD_LABEL: Record<keyof CertForm, string> = {
  materialName: "Материал",
  docType: "Тип документа",
  docNumber: "№ документа",
  docDate: "Дата документа",
  supplier: "Поставщик",
  deliveryId: "Поставка",
};

function certToForm(c: MaterialCertificate | null): CertForm {
  if (!c) return { ...EMPTY_CERT_FORM };
  return {
    materialName: c.material_name,
    docType: c.doc_type,
    docNumber: c.doc_number || "",
    docDate: c.doc_date || "",
    supplier: c.supplier || "",
    deliveryId: c.delivery_id || "",
  };
}

export default function PtoModule() {
  const today = useToday();

  const [objects, setObjects] = useState<ConstructionObject[]>([]);
  const [objectId, setObjectId] = useState<string>("");
  const [loadingObjects, setLoadingObjects] = useState(true);
  const [loadingData, setLoadingData] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [schemaMissing, setSchemaMissing] = useState(false);
  const [view, setView] = useState<View>("acts");

  const [tasks, setTasks] = useState<ScheduleTask[]>([]);
  const [acts, setActs] = useState<AcceptanceAct[]>([]);
  const [logs, setLogs] = useState<WorkLogEntry[]>([]);
  const [certs, setCerts] = useState<MaterialCertificate[]>([]);
  /** Заявки снабжения объекта — к ним привязываются сертификаты как к поставкам. */
  const [deliveries, setDeliveries] = useState<SupplyRequest[]>([]);

  // ---- акты ----
  const [openActTaskId, setOpenActTaskId] = useState<string | null>(null);
  const [actForm, setActForm] = useState<ActForm>(EMPTY_ACT_FORM);
  const [actBusy, setActBusy] = useState(false);
  const [pendingDeleteActId, setPendingDeleteActId] = useState<string | null>(null);

  // ---- журналы работ ----
  const [logPanelOpen, setLogPanelOpen] = useState(false);
  const [editingLogId, setEditingLogId] = useState<string | null>(null);
  const [logForm, setLogForm] = useState<LogForm>(emptyLogForm(null));
  const [logSaving, setLogSaving] = useState(false);
  const [logDetailId, setLogDetailId] = useState<string | null>(null);
  const [logPendingDeleteId, setLogPendingDeleteId] = useState<string | null>(null);

  // ---- сертификаты ----
  const [certPanelOpen, setCertPanelOpen] = useState(false);
  const [editingCertId, setEditingCertId] = useState<string | null>(null);
  const [certForm, setCertForm] = useState<CertForm>(EMPTY_CERT_FORM);
  const [certSaving, setCertSaving] = useState(false);
  const [certDetailId, setCertDetailId] = useState<string | null>(null);
  const [certPendingDeleteId, setCertPendingDeleteId] = useState<string | null>(null);

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

  const loadObjectData = useCallback(async (id: string) => {
    if (!id) {
      setTasks([]);
      setActs([]);
      setLogs([]);
      setCerts([]);
      setDeliveries([]);
      return;
    }
    setLoadingData(true);
    const [taskRes, actRes, logRes, certRes, supRes] = await Promise.all([
      supabase.from("schedule_tasks").select("*").eq("object_id", id).order("sort_order"),
      supabase.from("acceptance_acts").select("*").eq("object_id", id),
      supabase.from("work_log_entries").select("*").eq("object_id", id).order("entry_date", { ascending: false }),
      supabase.from("material_certificates").select("*").eq("object_id", id).order("created_at", { ascending: false }),
      supabase.from("supply_requests").select("*").eq("object_id", id).order("created_at", { ascending: false }),
    ]);
    const missing =
      needsSchemaSetup(taskRes.error) ||
      needsSchemaSetup(actRes.error) ||
      needsSchemaSetup(logRes.error) ||
      needsSchemaSetup(certRes.error);
    setSchemaMissing(missing);
    if (taskRes.error) setBanner(dbErrorText(taskRes.error, "Не удалось загрузить график"));
    else if (actRes.error && !needsSchemaSetup(actRes.error)) setBanner(dbErrorText(actRes.error, "Не удалось загрузить акты"));
    else if (logRes.error && !needsSchemaSetup(logRes.error)) setBanner(dbErrorText(logRes.error, "Не удалось загрузить журналы работ"));
    else if (certRes.error && !needsSchemaSetup(certRes.error)) setBanner(dbErrorText(certRes.error, "Не удалось загрузить сертификаты"));

    setTasks((taskRes.data as ScheduleTask[]) || []);
    setActs((actRes.data as AcceptanceAct[]) || []);
    setLogs((logRes.data as WorkLogEntry[]) || []);
    setCerts((certRes.data as MaterialCertificate[]) || []);
    // Снабжение — необязательная связь: без его таблиц реестр сертификатов работает сам по себе.
    setDeliveries(supRes.error ? [] : (supRes.data as SupplyRequest[]) || []);
    setLoadingData(false);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- состояние ставится после await, не синхронно
    loadObjects();
  }, [loadObjects]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- состояние ставится после await, не синхронно
    loadObjectData(objectId);
  }, [objectId, loadObjectData]);

  const tree = useMemo(() => (today ? buildTree(tasks, today) : []), [tasks, today]);
  const leaves = useMemo(() => flattenTree(tree).filter((n) => !n.isGroup), [tree]);

  /* ------------------------------ Акты: производные ------------------------------ */

  const actByTaskId = useMemo(() => {
    const m = new Map<string, AcceptanceAct>();
    acts.forEach((a) => m.set(a.task_id, a));
    return m;
  }, [acts]);

  const actRows: ActRow[] = useMemo(() => {
    if (!today) return [];
    const rows: ActRow[] = [];
    leaves.forEach((n) => {
      const act = actByTaskId.get(n.task.id) || null;
      if (n.progressFact < 100 && !act) return;
      rows.push({ node: n, act, daysWaiting: daysBetween(n.endFact || n.endPlan, today) });
    });
    return rows.sort((a, b) => {
      const aSigned = a.act?.status === "signed";
      const bSigned = b.act?.status === "signed";
      if (aSigned !== bSigned) return aSigned ? 1 : -1;
      return (b.daysWaiting ?? -1) - (a.daysWaiting ?? -1);
    });
  }, [leaves, actByTaskId, today]);

  const actStats = useMemo(() => {
    let awaiting = 0;
    let review = 0;
    let signed = 0;
    let overdue = 0;
    let frozen = 0;
    actRows.forEach((r) => {
      const status = r.act?.status;
      if (status === "signed") {
        signed++;
      } else {
        if (status === "review") review++;
        else awaiting++;
        if ((r.daysWaiting ?? 0) >= ACCEPTANCE_OVERDUE_DAYS) overdue++;
        frozen += r.node.costTotal || 0;
      }
    });
    return { awaiting, review, signed, overdue, frozen: Math.round(frozen * 100) / 100 };
  }, [actRows]);

  function openAct(row: ActRow) {
    setOpenActTaskId(row.node.task.id);
    setPendingDeleteActId(null);
    setActForm({
      status: row.act?.status || "draft",
      actNumber: row.act?.act_number || "",
      actDate: row.act?.act_date || today || "",
      amount: row.act?.amount != null ? String(row.act.amount) : row.node.costTotal != null ? String(row.node.costTotal) : "",
      description: row.act?.description || "",
      responsible: row.act?.responsible || "",
    });
  }

  function closeAct() {
    setOpenActTaskId(null);
    setPendingDeleteActId(null);
  }

  async function saveAct(row: ActRow) {
    setActBusy(true);
    const existing = row.act;
    const now = new Date().toISOString();
    const amountNum = actForm.amount === "" ? null : Number(actForm.amount);
    const parts: string[] = [];
    if ((existing?.status || "draft") !== actForm.status) {
      parts.push(`Статус: ${ACCEPTANCE_STATUS_LABEL[existing?.status || "draft"]} → ${ACCEPTANCE_STATUS_LABEL[actForm.status]}`);
    }
    if ((existing?.act_number || "") !== actForm.actNumber) {
      parts.push(`№ акта: ${existing?.act_number || "—"} → ${actForm.actNumber || "—"}`);
    }
    if ((existing?.amount ?? null) !== amountNum) {
      parts.push(`Сумма: ${fmtMoney(existing?.amount)} → ${fmtMoney(amountNum)}`);
    }
    if ((existing?.description || "") !== actForm.description.trim()) parts.push("Описание изменено");
    if ((existing?.responsible || "") !== actForm.responsible.trim()) parts.push("Ответственный изменён");
    const history: HistoryEntry[] = [
      ...(existing?.history || []),
      { at: now, text: parts.length ? parts.join("; ") : "Акт сохранён без изменений" },
    ];

    const { error } = await supabase.from("acceptance_acts").upsert(
      {
        task_id: row.node.task.id,
        object_id: objectId,
        status: actForm.status,
        act_number: actForm.actNumber.trim() || null,
        act_date: actForm.actDate || null,
        amount: amountNum,
        description: actForm.description.trim() || null,
        responsible: actForm.responsible.trim() || null,
        history,
        updated_at: now,
      },
      { onConflict: "task_id" }
    );
    setActBusy(false);
    if (error) {
      setBanner(dbErrorText(error, "Не удалось сохранить акт"));
      setSchemaMissing(needsSchemaSetup(error));
      return;
    }
    setOpenActTaskId(null);
    await loadObjectData(objectId);
  }

  async function deleteAct(actId: string) {
    setActBusy(true);
    const { error } = await supabase.from("acceptance_acts").delete().eq("id", actId);
    setActBusy(false);
    if (error) {
      setBanner(dbErrorText(error, "Не удалось удалить акт"));
      return;
    }
    setOpenActTaskId(null);
    setPendingDeleteActId(null);
    await loadObjectData(objectId);
  }

  /* ------------------------------ Журналы работ ------------------------------ */

  const logsSorted = useMemo(
    () => logs.slice().sort((a, b) => b.entry_date.localeCompare(a.entry_date) || b.created_at.localeCompare(a.created_at)),
    [logs]
  );

  function taskNameById(id: string | null): string {
    if (!id) return "—";
    return leaves.find((n) => n.task.id === id)?.task.name || "этап удалён";
  }

  function openLogPanel(id: string | null) {
    setEditingLogId(id);
    const e = id ? logs.find((x) => x.id === id) || null : null;
    setLogForm(logToForm(e, today));
    setLogPanelOpen(true);
  }
  function closeLogPanel() {
    setLogPanelOpen(false);
    setEditingLogId(null);
  }

  function logDiffText(old: WorkLogEntry | null, form: LogForm): string {
    const oldForm = logToForm(old, today);
    const parts: string[] = [];
    (Object.keys(LOG_FIELD_LABEL) as (keyof LogForm)[]).forEach((k) => {
      const ov = (oldForm[k] ?? "").trim();
      const nv = (form[k] ?? "").trim();
      if (ov === nv) return;
      const disp = (v: string) => {
        if (!v) return "—";
        if (k === "entryDate") return fmtDate(v);
        if (k === "taskId") return taskNameById(v);
        return v;
      };
      parts.push(`${LOG_FIELD_LABEL[k]}: ${disp(ov)} → ${disp(nv)}`);
    });
    return parts.join("; ");
  }

  async function saveLog() {
    if (!logForm.entryDate) {
      setBanner("Укажите дату записи журнала.");
      return;
    }
    if (!logForm.content.trim()) {
      setBanner("Опишите, что сделано за смену.");
      return;
    }
    setBanner(null);
    setLogSaving(true);
    const now = new Date().toISOString();
    const payload = {
      object_id: objectId,
      task_id: logForm.taskId || null,
      entry_date: logForm.entryDate,
      weather: logForm.weather.trim() || null,
      crew: logForm.crew.trim() || null,
      content: logForm.content.trim(),
      updated_at: now,
    };

    if (editingLogId) {
      const old = logs.find((x) => x.id === editingLogId) || null;
      const change = logDiffText(old, logForm);
      const history: HistoryEntry[] = [...(old?.history || []), { at: now, text: change || "Запись сохранена без изменений" }];
      const { error } = await supabase.from("work_log_entries").update({ ...payload, history }).eq("id", editingLogId);
      if (error) setBanner(dbErrorText(error, "Не удалось сохранить запись журнала"));
      else {
        closeLogPanel();
        await loadObjectData(objectId);
      }
    } else {
      const { error } = await supabase
        .from("work_log_entries")
        .insert({ ...payload, created_at: now, history: [{ at: now, text: "Запись создана" }] });
      if (error) setBanner(dbErrorText(error, "Не удалось добавить запись журнала"));
      else {
        closeLogPanel();
        await loadObjectData(objectId);
      }
    }
    setLogSaving(false);
  }

  async function deleteLog(id: string) {
    const { error } = await supabase.from("work_log_entries").delete().eq("id", id);
    if (error) setBanner(dbErrorText(error, "Не удалось удалить запись журнала"));
    else {
      if (logDetailId === id) setLogDetailId(null);
      await loadObjectData(objectId);
    }
    setLogPendingDeleteId(null);
  }

  /* ------------------------------ Сертификаты ------------------------------ */

  const certsSorted = useMemo(
    () => certs.slice().sort((a, b) => b.created_at.localeCompare(a.created_at)),
    [certs]
  );

  function deliveryLabel(id: string | null): string {
    if (!id) return "не привязана";
    const d = deliveries.find((x) => x.id === id);
    if (!d) return "заявка удалена";
    const when = d.delivery_fact ? `получено ${fmtDate(d.delivery_fact)}` : SUPPLY_STATUS_LABEL[d.status].toLowerCase();
    return `${d.material_name} — ${when}`;
  }

  /** Выбор поставки подставляет материал, если он ещё не вписан. */
  function pickDelivery(id: string) {
    const d = deliveries.find((x) => x.id === id);
    setCertForm((f) => ({
      ...f,
      deliveryId: id,
      materialName: f.materialName.trim() || d?.material_name || "",
    }));
  }

  function openCertPanel(id: string | null) {
    setEditingCertId(id);
    const c = id ? certs.find((x) => x.id === id) || null : null;
    setCertForm(certToForm(c));
    setCertPanelOpen(true);
  }
  function closeCertPanel() {
    setCertPanelOpen(false);
    setEditingCertId(null);
  }

  function certDiffText(old: MaterialCertificate | null, form: CertForm): string {
    const oldForm = certToForm(old);
    const parts: string[] = [];
    (Object.keys(CERT_FIELD_LABEL) as (keyof CertForm)[]).forEach((k) => {
      const ov = (oldForm[k] ?? "").trim();
      const nv = (form[k] ?? "").trim();
      if (ov === nv) return;
      const disp = (v: string) => {
        if (!v) return "—";
        if (k === "docType") return CERT_DOC_TYPE_LABEL[v as CertDocType] || v;
        if (k === "docDate") return fmtDate(v) === "—" ? v : fmtDate(v);
        if (k === "deliveryId") return deliveryLabel(v);
        return v;
      };
      parts.push(`${CERT_FIELD_LABEL[k]}: ${disp(ov)} → ${disp(nv)}`);
    });
    return parts.join("; ");
  }

  async function saveCert() {
    if (!certForm.materialName.trim()) {
      setBanner("Укажите наименование материала.");
      return;
    }
    setBanner(null);
    setCertSaving(true);
    const now = new Date().toISOString();
    const payload = {
      object_id: objectId,
      material_name: certForm.materialName.trim(),
      doc_type: certForm.docType,
      doc_number: certForm.docNumber.trim() || null,
      doc_date: certForm.docDate || null,
      supplier: certForm.supplier.trim() || null,
      delivery_id: certForm.deliveryId || null,
      updated_at: now,
    };

    if (editingCertId) {
      const old = certs.find((x) => x.id === editingCertId) || null;
      const change = certDiffText(old, certForm);
      const history: HistoryEntry[] = [...(old?.history || []), { at: now, text: change || "Запись сохранена без изменений" }];
      const { error } = await supabase.from("material_certificates").update({ ...payload, history }).eq("id", editingCertId);
      if (error) setBanner(dbErrorText(error, "Не удалось сохранить документ"));
      else {
        closeCertPanel();
        await loadObjectData(objectId);
      }
    } else {
      const { error } = await supabase
        .from("material_certificates")
        .insert({ ...payload, created_at: now, history: [{ at: now, text: "Документ добавлен в реестр" }] });
      if (error) setBanner(dbErrorText(error, "Не удалось добавить документ"));
      else {
        closeCertPanel();
        await loadObjectData(objectId);
      }
    }
    setCertSaving(false);
  }

  async function deleteCert(id: string) {
    const { error } = await supabase.from("material_certificates").delete().eq("id", id);
    if (error) setBanner(dbErrorText(error, "Не удалось удалить документ"));
    else {
      if (certDetailId === id) setCertDetailId(null);
      await loadObjectData(objectId);
    }
    setCertPendingDeleteId(null);
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
      {schemaMissing && <SchemaSetup onRecheck={() => loadObjectData(objectId)} />}

      <div className="obj-picker">
        <CurrentObject name={objects.find((o) => o.id === objectId)?.name ?? null} loading={loadingObjects} />
        {selectedObject && <span className="obj-picker-meta">{selectedObject.address}</span>}
      </div>

      <div className="toolbar">
        <div className="seg" role="tablist" aria-label="Раздел ПТО">
          <button className={`seg-btn${view === "acts" ? " active" : ""}`} onClick={() => setView("acts")}>
            Приёмка и акты
          </button>
          <button className={`seg-btn${view === "log" ? " active" : ""}`} onClick={() => setView("log")}>
            Журналы работ
          </button>
          <button className={`seg-btn${view === "certs" ? " active" : ""}`} onClick={() => setView("certs")}>
            Сертификаты и паспорта
          </button>
        </div>
        {view === "log" && (
          <button className="btn btn-primary" onClick={() => openLogPanel(null)} disabled={!objectId}>
            + Запись в журнал
          </button>
        )}
        {view === "certs" && (
          <button className="btn btn-primary" onClick={() => openCertPanel(null)} disabled={!objectId}>
            + Документ
          </button>
        )}
      </div>

      {!objectId ? (
        <div className="empty-state">Сначала создайте объект в модуле «Объекты».</div>
      ) : loadingData || !today ? (
        <div className="empty-state">Загрузка…</div>
      ) : view === "acts" ? (
        <ActsView
          rows={actRows}
          stats={actStats}
          openActTaskId={openActTaskId}
          actForm={actForm}
          setActForm={setActForm}
          actBusy={actBusy}
          onOpen={openAct}
          onClose={closeAct}
          onSave={saveAct}
          pendingDeleteActId={pendingDeleteActId}
          setPendingDeleteActId={setPendingDeleteActId}
          onDelete={deleteAct}
        />
      ) : view === "log" ? (
        <LogView
          entries={logsSorted}
          detailId={logDetailId}
          setDetailId={setLogDetailId}
          taskNameById={taskNameById}
          pendingDeleteId={logPendingDeleteId}
          setPendingDeleteId={setLogPendingDeleteId}
          onEdit={openLogPanel}
          onDelete={deleteLog}
        />
      ) : (
        <CertsView
          items={certsSorted}
          detailId={certDetailId}
          setDetailId={setCertDetailId}
          pendingDeleteId={certPendingDeleteId}
          setPendingDeleteId={setCertPendingDeleteId}
          onEdit={openCertPanel}
          onDelete={deleteCert}
          deliveryLabel={deliveryLabel}
        />
      )}

      {/* ---- Панель журнала работ ---- */}
      <div className={`overlay${logPanelOpen ? " show" : ""}`} onClick={closeLogPanel} />
      <div className={`panel${logPanelOpen ? " show" : ""}`}>
        <div className="panel-head">
          <h3>{editingLogId ? "Изменить запись" : "Новая запись журнала"}</h3>
          <button className="panel-close" aria-label="Закрыть" onClick={closeLogPanel}>
            ✕
          </button>
        </div>
        <div className="panel-body">
          <div className="field-row">
            <div className="field">
              <label>
                Дата <span className="req">*</span>
              </label>
              <input
                type="date"
                value={logForm.entryDate}
                onChange={(e) => setLogForm({ ...logForm, entryDate: e.target.value })}
              />
            </div>
            <div className="field">
              <label>Погода</label>
              <input
                type="text"
                placeholder="напр. −3°C, снег"
                value={logForm.weather}
                onChange={(e) => setLogForm({ ...logForm, weather: e.target.value })}
              />
            </div>
          </div>
          <div className="field">
            <label>Этап графика</label>
            <select value={logForm.taskId} onChange={(e) => setLogForm({ ...logForm, taskId: e.target.value })}>
              <option value="">— без привязки —</option>
              {leaves.map((n) => (
                <option key={n.task.id} value={n.task.id}>
                  {n.task.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Бригада / исполнитель</label>
            <input
              type="text"
              placeholder="напр. бригада Петрова, 6 чел."
              value={logForm.crew}
              onChange={(e) => setLogForm({ ...logForm, crew: e.target.value })}
            />
          </div>
          <div className="field">
            <label>
              Что сделано за смену <span className="req">*</span>
            </label>
            <textarea
              placeholder="напр. Забетонирован ростверк оси 1–4, захватка 2, 42 м³"
              value={logForm.content}
              onChange={(e) => setLogForm({ ...logForm, content: e.target.value })}
            />
          </div>
        </div>
        <div className="panel-foot">
          <button className="btn btn-ghost" onClick={closeLogPanel}>
            Отмена
          </button>
          <button className="btn btn-primary" onClick={saveLog} disabled={logSaving}>
            {logSaving ? "Сохранение…" : "Сохранить"}
          </button>
        </div>
      </div>

      {/* ---- Панель сертификата ---- */}
      <div className={`overlay${certPanelOpen ? " show" : ""}`} onClick={closeCertPanel} />
      <div className={`panel${certPanelOpen ? " show" : ""}`}>
        <div className="panel-head">
          <h3>{editingCertId ? "Изменить документ" : "Новый документ"}</h3>
          <button className="panel-close" aria-label="Закрыть" onClick={closeCertPanel}>
            ✕
          </button>
        </div>
        <div className="panel-body">
          <div className="field">
            <label>
              Материал <span className="req">*</span>
            </label>
            <input
              type="text"
              placeholder="напр. Арматура А500С ⌀16"
              value={certForm.materialName}
              onChange={(e) => setCertForm({ ...certForm, materialName: e.target.value })}
            />
          </div>
          <div className="field">
            <label>Тип документа</label>
            <select
              value={certForm.docType}
              onChange={(e) => setCertForm({ ...certForm, docType: e.target.value as CertDocType })}
            >
              <option value="certificate">Сертификат</option>
              <option value="passport">Паспорт</option>
              <option value="other">Иной документ</option>
            </select>
          </div>
          <div className="field-row">
            <div className="field">
              <label>№ документа</label>
              <input
                type="text"
                value={certForm.docNumber}
                onChange={(e) => setCertForm({ ...certForm, docNumber: e.target.value })}
              />
            </div>
            <div className="field">
              <label>Дата документа</label>
              <input
                type="date"
                value={certForm.docDate}
                onChange={(e) => setCertForm({ ...certForm, docDate: e.target.value })}
              />
            </div>
          </div>
          <div className="field">
            <label>Поставщик</label>
            <input
              type="text"
              placeholder="напр. ООО «Металлоснаб»"
              value={certForm.supplier}
              onChange={(e) => setCertForm({ ...certForm, supplier: e.target.value })}
            />
          </div>
          <div className="field">
            <label>Поставка (заявка снабжения)</label>
            <select value={certForm.deliveryId} onChange={(e) => pickDelivery(e.target.value)}>
              <option value="">— не привязана —</option>
              {deliveries
                .filter((d) => d.status !== "cancelled")
                .map((d) => (
                  <option key={d.id} value={d.id}>
                    {deliveryLabel(d.id)}
                  </option>
                ))}
            </select>
            <p className="hint">
              Показаны заявки модуля «Снабжение» по этому объекту. Выбор подставит наименование
              материала, если оно ещё не вписано.
            </p>
          </div>
        </div>
        <div className="panel-foot">
          <button className="btn btn-ghost" onClick={closeCertPanel}>
            Отмена
          </button>
          <button className="btn btn-primary" onClick={saveCert} disabled={certSaving}>
            {certSaving ? "Сохранение…" : "Сохранить"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================== Подвиды ============================== */

function ActsView({
  rows,
  stats,
  openActTaskId,
  actForm,
  setActForm,
  actBusy,
  onOpen,
  onClose,
  onSave,
  pendingDeleteActId,
  setPendingDeleteActId,
  onDelete,
}: {
  rows: ActRow[];
  stats: { awaiting: number; review: number; signed: number; overdue: number; frozen: number };
  openActTaskId: string | null;
  actForm: ActForm;
  setActForm: (f: ActForm | ((cur: ActForm) => ActForm)) => void;
  actBusy: boolean;
  onOpen: (row: ActRow) => void;
  onClose: () => void;
  onSave: (row: ActRow) => void;
  pendingDeleteActId: string | null;
  setPendingDeleteActId: (id: string | null) => void;
  onDelete: (actId: string) => void;
}) {
  const dbl = useDoubleTap();
  return (
    <div>
      <div className="stats">
        <div className="stat-total">
          <span className="n">{rows.length}</span>
          <span className="l">{plural(rows.length, "этап в реестре", "этапа в реестре", "этапов в реестре")}</span>
        </div>
        <div className="chip-row">
          <span className="chip st-bad">
            <span className="n">{stats.overdue}</span> просрочено
          </span>
          <span className="chip st-warn">
            <span className="n">{stats.review}</span> на согласовании
          </span>
          <span className="chip st-neutral">
            <span className="n">{stats.awaiting}</span> ожидают акта
          </span>
          <span className="chip st-good">
            <span className="n">{stats.signed}</span> подписано
          </span>
          {stats.frozen > 0 && (
            <span className="chip st-neutral">
              <span className="n">{fmtMoney(stats.frozen)}</span> без подписанного акта
            </span>
          )}
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="empty-state">
          Этапов, ожидающих закрытия документами, пока нет — они появятся здесь, как только
          какая-то работа в графике будет закрыта на 100%.
        </div>
      ) : (
        <ul className="accept-list">
          {rows.map((r) => {
            const isOpen = openActTaskId === r.node.task.id;
            const status = r.act?.status || null;
            const overdue = !status || status !== "signed" ? (r.daysWaiting ?? 0) >= ACCEPTANCE_OVERDUE_DAYS : false;
            return (
              <li key={r.node.task.id} className="accept-item">
                <div className="accept-row" onClick={dbl(r.node.task.id, () => (isOpen ? onClose() : onOpen(r)))} title={DOUBLE_TAP_HINT}>
                  <div className="accept-main">
                    <div className="accept-name">{r.node.task.name}</div>
                    <div className="accept-sub">
                      готовность {r.node.progressFact}% · {fmtDate(r.node.endFact || r.node.endPlan)}
                      {r.act?.act_number ? ` · акт №${r.act.act_number}` : ""}
                    </div>
                  </div>
                  <div className="accept-meta">
                    <span className="mono">{fmtMoney(r.node.costTotal)}</span>
                    {status ? (
                      <span className={`status-pill ${ACCEPTANCE_STATUS_CLASS[status]}`}>
                        {ACCEPTANCE_STATUS_LABEL[status]}
                      </span>
                    ) : (
                      <span className={`chip ${overdue ? "st-bad" : "st-neutral"}`}>
                        {r.daysWaiting !== null
                          ? `${r.daysWaiting} ${plural(r.daysWaiting, "день", "дня", "дней")} без акта`
                          : "акта нет"}
                      </span>
                    )}
                  </div>
                </div>

                {isOpen && (
                  <div className="accept-form">
                    <div className="field-row">
                      <div className="field">
                        <label>Статус</label>
                        <select
                          value={actForm.status}
                          onChange={(e) => setActForm((f) => ({ ...f, status: e.target.value as AcceptanceStatus }))}
                        >
                          <option value="draft">Черновик</option>
                          <option value="review">На согласовании</option>
                          <option value="signed">Подписан</option>
                        </select>
                      </div>
                      <div className="field">
                        <label>№ акта</label>
                        <input
                          value={actForm.actNumber}
                          onChange={(e) => setActForm((f) => ({ ...f, actNumber: e.target.value }))}
                        />
                      </div>
                    </div>
                    <div className="field-row">
                      <div className="field">
                        <label>Дата акта</label>
                        <input
                          type="date"
                          value={actForm.actDate}
                          onChange={(e) => setActForm((f) => ({ ...f, actDate: e.target.value }))}
                        />
                      </div>
                      <div className="field">
                        <label>Сумма, ₽</label>
                        <input
                          type="number"
                          value={actForm.amount}
                          onChange={(e) => setActForm((f) => ({ ...f, amount: e.target.value }))}
                        />
                      </div>
                    </div>
                    <div className="field">
                      <label>Ответственный со стороны исполнителя</label>
                      <input
                        type="text"
                        placeholder="напр. прораб Иванов И. И."
                        value={actForm.responsible}
                        onChange={(e) => setActForm((f) => ({ ...f, responsible: e.target.value }))}
                      />
                    </div>
                    <div className="field">
                      <label>Что скрыто актом</label>
                      <textarea
                        placeholder="напр. Армирование ростверка оси 1–4 до заливки бетоном"
                        value={actForm.description}
                        onChange={(e) => setActForm((f) => ({ ...f, description: e.target.value }))}
                      />
                    </div>

                    {r.act?.history && r.act.history.length > 0 && (
                      <ul className="history-list">
                        {r.act.history
                          .slice()
                          .reverse()
                          .map((h, i) => (
                            <li key={i}>
                              <time>{fmtDateTime(h.at)}</time>
                              {h.text}
                            </li>
                          ))}
                      </ul>
                    )}

                    <div className="accept-actions">
                      {r.act && r.act.status !== "signed" && (
                        pendingDeleteActId === r.act.id ? (
                          <button
                            className="btn btn-sm btn-danger"
                            disabled={actBusy}
                            onClick={() => onDelete(r.act!.id)}
                          >
                            Точно удалить?
                          </button>
                        ) : (
                          <button className="btn btn-sm btn-ghost" disabled={actBusy} onClick={() => setPendingDeleteActId(r.act!.id)}>
                            Удалить
                          </button>
                        )
                      )}
                      <button className="btn btn-ghost btn-sm" onClick={onClose} disabled={actBusy}>
                        Отмена
                      </button>
                      <button className="btn btn-primary btn-sm" onClick={() => onSave(r)} disabled={actBusy}>
                        Сохранить
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function LogView({
  entries,
  detailId,
  setDetailId,
  taskNameById,
  pendingDeleteId,
  setPendingDeleteId,
  onEdit,
  onDelete,
}: {
  entries: WorkLogEntry[];
  detailId: string | null;
  setDetailId: (id: string | null) => void;
  taskNameById: (id: string | null) => string;
  pendingDeleteId: string | null;
  setPendingDeleteId: (id: string | null) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const dbl = useDoubleTap();
  function renderDetail(e: WorkLogEntry) {
    const history = (e.history || []).slice().reverse();
    return (
      <div className="detail">
        <div className="detail-block">
          <h4>Запись журнала</h4>
          <dl>
            <dt>Дата</dt>
            <dd className="mono">{fmtDate(e.entry_date)}</dd>
            <dt>Этап графика</dt>
            <dd>{taskNameById(e.task_id)}</dd>
            <dt>Бригада</dt>
            <dd>{e.crew || "—"}</dd>
            <dt>Погода</dt>
            <dd>{e.weather || "—"}</dd>
            <dt>Содержание</dt>
            <dd>{e.content}</dd>
          </dl>
          <div className="detail-actions">
            <button
              className="btn btn-sm btn-ghost"
              onClick={(ev) => {
                ev.stopPropagation();
                onEdit(e.id);
              }}
            >
              Изменить
            </button>
            {pendingDeleteId === e.id ? (
              <button
                className="btn btn-sm btn-danger"
                onClick={(ev) => {
                  ev.stopPropagation();
                  onDelete(e.id);
                }}
              >
                Точно удалить?
              </button>
            ) : (
              <button
                className="btn btn-sm btn-ghost"
                onClick={(ev) => {
                  ev.stopPropagation();
                  setPendingDeleteId(e.id);
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

  if (entries.length === 0) {
    return <div className="empty-state">Записей в журнале работ пока нет — добавьте первую.</div>;
  }

  return (
    <>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Дата</th>
              <th>Этап</th>
              <th>Бригада</th>
              <th>Погода</th>
              <th>Содержание</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <Fragment key={e.id}>
                <tr className="obj-row" onClick={dbl(e.id, () => setDetailId(detailId === e.id ? null : e.id))} title={DOUBLE_TAP_HINT}>
                  <td className="mono">{fmtDate(e.entry_date)}</td>
                  <td>{taskNameById(e.task_id)}</td>
                  <td>{e.crew || "—"}</td>
                  <td>{e.weather || "—"}</td>
                  <td className="addr-cell">{e.content}</td>
                </tr>
                {detailId === e.id && (
                  <tr className="detail-row">
                    <td colSpan={5}>{renderDetail(e)}</td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <div className="cards">
        {entries.map((e) => (
          <div className="obj-card" key={e.id} onClick={dbl(e.id, () => setDetailId(detailId === e.id ? null : e.id))} title={DOUBLE_TAP_HINT}>
            <div className="row1">
              <div>
                <div className="cname">{fmtDate(e.entry_date)}</div>
                <div className="caddr">{taskNameById(e.task_id)}</div>
              </div>
            </div>
            <div className="cmeta">
              {e.crew && <span>{e.crew}</span>}
              {e.weather && <span>{e.weather}</span>}
            </div>
            <div className="cmeta">
              <span>{e.content}</span>
            </div>
            {detailId === e.id && renderDetail(e)}
          </div>
        ))}
      </div>
    </>
  );
}

function CertsView({
  items,
  detailId,
  setDetailId,
  pendingDeleteId,
  setPendingDeleteId,
  onEdit,
  onDelete,
  deliveryLabel,
}: {
  items: MaterialCertificate[];
  detailId: string | null;
  setDetailId: (id: string | null) => void;
  pendingDeleteId: string | null;
  setPendingDeleteId: (id: string | null) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  deliveryLabel: (id: string | null) => string;
}) {
  const dbl = useDoubleTap();
  function renderDetail(c: MaterialCertificate) {
    const history = (c.history || []).slice().reverse();
    return (
      <div className="detail">
        <div className="detail-block">
          <h4>Документ</h4>
          <dl>
            <dt>Материал</dt>
            <dd>{c.material_name}</dd>
            <dt>Тип</dt>
            <dd>{CERT_DOC_TYPE_LABEL[c.doc_type]}</dd>
            <dt>№ документа</dt>
            <dd className="mono">{c.doc_number || "—"}</dd>
            <dt>Дата документа</dt>
            <dd className="mono">{fmtDate(c.doc_date)}</dd>
            <dt>Поставщик</dt>
            <dd>{c.supplier || "—"}</dd>
            <dt>Поставка</dt>
            <dd>{deliveryLabel(c.delivery_id)}</dd>
          </dl>
          <div className="detail-actions">
            <button
              className="btn btn-sm btn-ghost"
              onClick={(ev) => {
                ev.stopPropagation();
                onEdit(c.id);
              }}
            >
              Изменить
            </button>
            {pendingDeleteId === c.id ? (
              <button
                className="btn btn-sm btn-danger"
                onClick={(ev) => {
                  ev.stopPropagation();
                  onDelete(c.id);
                }}
              >
                Точно удалить?
              </button>
            ) : (
              <button
                className="btn btn-sm btn-ghost"
                onClick={(ev) => {
                  ev.stopPropagation();
                  setPendingDeleteId(c.id);
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

  if (items.length === 0) {
    return <div className="empty-state">Сертификатов и паспортов в реестре пока нет — добавьте первый.</div>;
  }

  return (
    <>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Материал</th>
              <th>Тип</th>
              <th>№ документа</th>
              <th>Дата</th>
              <th>Поставщик</th>
              <th>Поставка</th>
            </tr>
          </thead>
          <tbody>
            {items.map((c) => (
              <Fragment key={c.id}>
                <tr className="obj-row" onClick={dbl(c.id, () => setDetailId(detailId === c.id ? null : c.id))} title={DOUBLE_TAP_HINT}>
                  <td className="name-cell">{c.material_name}</td>
                  <td>{CERT_DOC_TYPE_LABEL[c.doc_type]}</td>
                  <td className="mono">{c.doc_number || "—"}</td>
                  <td className="mono">{fmtDate(c.doc_date)}</td>
                  <td>{c.supplier || "—"}</td>
                  <td className="addr-cell">{c.delivery_id ? deliveryLabel(c.delivery_id) : "—"}</td>
                </tr>
                {detailId === c.id && (
                  <tr className="detail-row">
                    <td colSpan={6}>{renderDetail(c)}</td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <div className="cards">
        {items.map((c) => (
          <div className="obj-card" key={c.id} onClick={dbl(c.id, () => setDetailId(detailId === c.id ? null : c.id))} title={DOUBLE_TAP_HINT}>
            <div className="row1">
              <div>
                <div className="cname">{c.material_name}</div>
                <div className="caddr">{CERT_DOC_TYPE_LABEL[c.doc_type]}</div>
              </div>
            </div>
            <div className="cmeta">
              <span className="mono">{c.doc_number || "—"}</span>
              <span className="mono">{fmtDate(c.doc_date)}</span>
              {c.supplier && <span>{c.supplier}</span>}
            </div>
            {detailId === c.id && renderDetail(c)}
          </div>
        ))}
      </div>
    </>
  );
}

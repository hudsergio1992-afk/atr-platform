"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { dbErrorText, needsSchemaSetup } from "@/lib/dbError";
import {
  ConstructionObject,
  HistoryEntry,
  ScheduleTask,
  Supplier,
  SupplyOffer,
  SupplyRequest,
  SupplyStatus,
  SUPPLY_STATUS_CLASS,
  SUPPLY_STATUS_LABEL,
  UNITS,
} from "@/lib/types";
import { buildTree, flattenTree, parseDay } from "@/lib/schedule";
import { computeSupplierStats, summarizeRequests } from "@/lib/supply";
import { fmtDate, fmtDateTime, fmtMoney, fmtNum, fmtPercent, plural } from "@/lib/format";
import { OBJECT_KEY, readSetting, useToday } from "@/lib/useClient";
import SchemaSetup from "@/components/SchemaSetup";
import CurrentObject from "@/components/CurrentObject";
import { DOUBLE_TAP_HINT, useDoubleTap } from "@/lib/useDoubleTap";

/** Выбранный объект — общий для всех вкладок: выбрали на одной, открыт и на остальных. */
const LS_OBJECT_KEY = OBJECT_KEY;

type View = "requests" | "suppliers";

const STATUS_ORDER: SupplyStatus[] = ["draft", "pricing", "approved", "ordered", "delivered", "cancelled"];

/* ============================== Заявка ============================== */

interface RequestForm {
  materialName: string;
  quantity: string;
  unit: string;
  neededBy: string;
  taskId: string;
  status: SupplyStatus;
  supplierId: string;
  orderAmount: string;
  orderDate: string;
  deliveryDue: string;
  deliveryFact: string;
  note: string;
}

const EMPTY_REQUEST_FORM: RequestForm = {
  materialName: "",
  quantity: "",
  unit: "",
  neededBy: "",
  taskId: "",
  status: "draft",
  supplierId: "",
  orderAmount: "",
  orderDate: "",
  deliveryDue: "",
  deliveryFact: "",
  note: "",
};

const REQUEST_FIELD_LABEL: Record<keyof RequestForm, string> = {
  materialName: "Материал",
  quantity: "Количество",
  unit: "Ед. изм.",
  neededBy: "Нужно к",
  taskId: "Этап",
  status: "Статус",
  supplierId: "Поставщик",
  orderAmount: "Сумма заказа",
  orderDate: "Дата заказа",
  deliveryDue: "Срок доставки",
  deliveryFact: "Получено",
  note: "Примечание",
};

const DATE_FIELDS = new Set<keyof RequestForm>(["neededBy", "orderDate", "deliveryDue", "deliveryFact"]);

function requestToForm(r: SupplyRequest | null): RequestForm {
  if (!r) return { ...EMPTY_REQUEST_FORM };
  return {
    materialName: r.material_name,
    quantity: r.quantity != null ? String(r.quantity) : "",
    unit: r.unit || "",
    neededBy: r.needed_by || "",
    taskId: r.task_id || "",
    status: r.status,
    supplierId: r.supplier_id || "",
    orderAmount: r.order_amount != null ? String(r.order_amount) : "",
    orderDate: r.order_date || "",
    deliveryDue: r.delivery_due || "",
    deliveryFact: r.delivery_fact || "",
    note: r.note || "",
  };
}

/* ============================== Предложение ============================== */

interface OfferForm {
  supplierId: string;
  supplierName: string;
  price: string;
  note: string;
}

const EMPTY_OFFER_FORM: OfferForm = { supplierId: "", supplierName: "", price: "", note: "" };

/* ============================== Поставщик ============================== */

interface SupplierForm {
  name: string;
  contactPerson: string;
  phone: string;
  email: string;
  rating: string;
  paymentTerms: string;
  note: string;
}

const EMPTY_SUPPLIER_FORM: SupplierForm = {
  name: "",
  contactPerson: "",
  phone: "",
  email: "",
  rating: "",
  paymentTerms: "",
  note: "",
};

const SUPPLIER_FIELD_LABEL: Record<keyof SupplierForm, string> = {
  name: "Название",
  contactPerson: "Контакт",
  phone: "Телефон",
  email: "Email",
  rating: "Рейтинг",
  paymentTerms: "Условия оплаты",
  note: "Примечание",
};

function supplierToForm(s: Supplier | null): SupplierForm {
  if (!s) return { ...EMPTY_SUPPLIER_FORM };
  return {
    name: s.name,
    contactPerson: s.contact_person || "",
    phone: s.phone || "",
    email: s.email || "",
    rating: s.rating != null ? String(s.rating) : "",
    paymentTerms: s.payment_terms || "",
    note: s.note || "",
  };
}

function numOrNull(v: string): number | null {
  if (v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

export default function SupplyModule() {
  const dbl = useDoubleTap();
  const today = useToday();

  const [objects, setObjects] = useState<ConstructionObject[]>([]);
  const [objectId, setObjectId] = useState<string>("");
  const [loadingObjects, setLoadingObjects] = useState(true);
  const [loadingData, setLoadingData] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [schemaMissing, setSchemaMissing] = useState(false);
  const [view, setView] = useState<View>("requests");

  const [tasks, setTasks] = useState<ScheduleTask[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  /** Заявки всех объектов: % поставок в срок считается по всей базе, а не по одному объекту. */
  const [allRequests, setAllRequests] = useState<SupplyRequest[]>([]);
  const [offers, setOffers] = useState<SupplyOffer[]>([]);

  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState<string>("open");
  const [busy, setBusy] = useState(false);

  // ---- заявки ----
  const [detailId, setDetailId] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<RequestForm>(EMPTY_REQUEST_FORM);
  const [saving, setSaving] = useState(false);

  // ---- предложения ----
  const [offerForm, setOfferForm] = useState<OfferForm>(EMPTY_OFFER_FORM);
  const [pendingDeleteOfferId, setPendingDeleteOfferId] = useState<string | null>(null);

  // ---- поставщики ----
  const [supDetailId, setSupDetailId] = useState<string | null>(null);
  const [supPendingDeleteId, setSupPendingDeleteId] = useState<string | null>(null);
  const [supPanelOpen, setSupPanelOpen] = useState(false);
  const [editingSupId, setEditingSupId] = useState<string | null>(null);
  const [supForm, setSupForm] = useState<SupplierForm>(EMPTY_SUPPLIER_FORM);
  const [supSaving, setSupSaving] = useState(false);

  const loadObjects = useCallback(async () => {
    setLoadingObjects(true);
    const { data, error } = await supabase.from("objects").select("*").order("created_at", { ascending: false });
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

  const loadData = useCallback(async (id: string) => {
    setLoadingData(true);
    const [taskRes, supRes, reqRes] = await Promise.all([
      id
        ? supabase.from("schedule_tasks").select("*").eq("object_id", id).order("sort_order")
        : Promise.resolve({ data: [], error: null }),
      supabase.from("suppliers").select("*").order("name"),
      supabase.from("supply_requests").select("*").order("created_at", { ascending: false }),
    ]);
    const missing = needsSchemaSetup(supRes.error) || needsSchemaSetup(reqRes.error);
    if (taskRes.error) setBanner(dbErrorText(taskRes.error, "Не удалось загрузить график"));
    else if (supRes.error && !needsSchemaSetup(supRes.error)) setBanner(dbErrorText(supRes.error, "Не удалось загрузить поставщиков"));
    else if (reqRes.error && !needsSchemaSetup(reqRes.error)) setBanner(dbErrorText(reqRes.error, "Не удалось загрузить заявки"));

    const reqs = (reqRes.data as SupplyRequest[]) || [];
    setTasks((taskRes.data as ScheduleTask[]) || []);
    setSuppliers((supRes.data as Supplier[]) || []);
    setAllRequests(reqs);

    const objReqIds = reqs.filter((r) => r.object_id === id).map((r) => r.id);
    let offersMissing = false;
    if (objReqIds.length) {
      const { data, error } = await supabase
        .from("supply_offers")
        .select("*")
        .in("request_id", objReqIds)
        .order("created_at");
      if (error) {
        offersMissing = needsSchemaSetup(error);
        if (!offersMissing) setBanner(dbErrorText(error, "Не удалось загрузить предложения поставщиков"));
      }
      setOffers((data as SupplyOffer[]) || []);
    } else {
      setOffers([]);
    }
    setSchemaMissing(missing || offersMissing);
    setLoadingData(false);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- состояние ставится после await, не синхронно
    loadObjects();
  }, [loadObjects]);

  useEffect(() => {
    if (loadingObjects) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- состояние ставится после await, не синхронно
    loadData(objectId);
  }, [objectId, loadingObjects, loadData]);

  const leaves = useMemo(
    () => (today ? flattenTree(buildTree(tasks, today)).filter((n) => !n.isGroup) : []),
    [tasks, today]
  );
  const taskName = useCallback(
    (id: string | null) => (id ? leaves.find((n) => n.task.id === id)?.task.name || "этап удалён" : "—"),
    [leaves]
  );
  const supplierById = useMemo(() => {
    const m = new Map<string, Supplier>();
    suppliers.forEach((s) => m.set(s.id, s));
    return m;
  }, [suppliers]);
  const supplierName = useCallback(
    (id: string | null) => (id ? supplierById.get(id)?.name || "поставщик удалён" : "—"),
    [supplierById]
  );

  const requests = useMemo(() => allRequests.filter((r) => r.object_id === objectId), [allRequests, objectId]);
  const supplierStats = useMemo(() => computeSupplierStats(allRequests), [allRequests]);
  const summary = useMemo(() => (today ? summarizeRequests(requests, today) : null), [requests, today]);

  const offersByRequest = useMemo(() => {
    const m = new Map<string, SupplyOffer[]>();
    offers.forEach((o) => {
      const list = m.get(o.request_id);
      if (list) list.push(o);
      else m.set(o.request_id, [o]);
    });
    return m;
  }, [offers]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return requests.filter((r) => {
      if (filterStatus === "open" && (r.status === "delivered" || r.status === "cancelled")) return false;
      if (filterStatus && filterStatus !== "open" && r.status !== filterStatus) return false;
      if (q) {
        const hay = `${r.material_name} ${supplierName(r.supplier_id)} ${taskName(r.task_id)}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [requests, filterStatus, search, supplierName, taskName]);

  /** Доставка просрочена: срок прошёл, а материал ещё не получен. */
  function deliveryLate(r: SupplyRequest): boolean {
    if (!today || r.status === "delivered" || r.status === "cancelled") return false;
    const due = parseDay(r.delivery_due);
    const t = parseDay(today);
    return due !== null && t !== null && t > due;
  }

  /** Заявка не успевает к сроку потребности: материал нужен раньше, чем обещана доставка. */
  function neededLate(r: SupplyRequest): boolean {
    if (r.status === "delivered" || r.status === "cancelled") return false;
    const need = parseDay(r.needed_by);
    const due = parseDay(r.delivery_due);
    return need !== null && due !== null && due > need;
  }

  /* ------------------------------ Заявки: CRUD ------------------------------ */

  function openPanel(id: string | null) {
    setEditingId(id);
    const r = id ? requests.find((x) => x.id === id) || null : null;
    setForm(requestToForm(r));
    setPanelOpen(true);
  }
  function closePanel() {
    setPanelOpen(false);
    setEditingId(null);
  }

  /** Выбор этапа подставляет единицу и срок потребности — к началу работ по плану. */
  function pickTask(taskId: string) {
    const node = leaves.find((n) => n.task.id === taskId);
    setForm((f) => ({
      ...f,
      taskId,
      unit: f.unit || node?.unit || "",
      neededBy: f.neededBy || node?.startPlan || "",
    }));
  }

  function requestDiff(old: SupplyRequest | null, f: RequestForm): string {
    const o = requestToForm(old);
    const parts: string[] = [];
    (Object.keys(REQUEST_FIELD_LABEL) as (keyof RequestForm)[]).forEach((k) => {
      const ov = String(o[k] ?? "").trim();
      const nv = String(f[k] ?? "").trim();
      if (ov === nv) return;
      const disp = (v: string) => {
        if (!v) return "—";
        if (DATE_FIELDS.has(k)) return fmtDate(v);
        if (k === "status") return SUPPLY_STATUS_LABEL[v as SupplyStatus] || v;
        if (k === "taskId") return taskName(v);
        if (k === "supplierId") return supplierName(v);
        if (k === "orderAmount") return fmtMoney(v);
        return v;
      };
      parts.push(`${REQUEST_FIELD_LABEL[k]}: ${disp(ov)} → ${disp(nv)}`);
    });
    return parts.join("; ");
  }

  async function saveRequest() {
    if (!form.materialName.trim()) {
      setBanner("Укажите наименование материала.");
      return;
    }
    const qty = numOrNull(form.quantity);
    const amount = numOrNull(form.orderAmount);
    if (Number.isNaN(qty) || (qty !== null && qty < 0)) {
      setBanner("Количество должно быть неотрицательным числом.");
      return;
    }
    if (Number.isNaN(amount) || (amount !== null && amount < 0)) {
      setBanner("Сумма заказа должна быть неотрицательным числом.");
      return;
    }
    if (form.status === "delivered" && !form.deliveryFact) {
      setBanner("Для статуса «Доставлено» укажите дату фактического получения.");
      return;
    }
    setBanner(null);
    setSaving(true);
    const now = new Date().toISOString();
    const payload = {
      object_id: objectId,
      task_id: form.taskId || null,
      material_name: form.materialName.trim(),
      quantity: qty,
      unit: form.unit.trim() || null,
      needed_by: form.neededBy || null,
      status: form.status,
      supplier_id: form.supplierId || null,
      order_amount: amount,
      order_date: form.orderDate || null,
      delivery_due: form.deliveryDue || null,
      delivery_fact: form.deliveryFact || null,
      note: form.note.trim() || null,
      updated_at: now,
    };
    if (editingId) {
      const old = requests.find((x) => x.id === editingId) || null;
      const history: HistoryEntry[] = [
        ...(old?.history || []),
        { at: now, text: requestDiff(old, form) || "Данные сохранены без изменений" },
      ];
      const { error } = await supabase.from("supply_requests").update({ ...payload, history }).eq("id", editingId);
      if (error) setBanner(dbErrorText(error, "Не удалось сохранить заявку"));
      else {
        closePanel();
        await loadData(objectId);
      }
    } else {
      const { error } = await supabase
        .from("supply_requests")
        .insert({ ...payload, created_at: now, history: [{ at: now, text: "Заявка создана" }] });
      if (error) setBanner(dbErrorText(error, "Не удалось создать заявку"));
      else {
        closePanel();
        await loadData(objectId);
      }
    }
    setSaving(false);
  }

  async function patchRequest(r: SupplyRequest, patch: Partial<SupplyRequest>, text: string) {
    setBusy(true);
    const now = new Date().toISOString();
    const history: HistoryEntry[] = [...(r.history || []), { at: now, text }];
    const { error } = await supabase
      .from("supply_requests")
      .update({ ...patch, history, updated_at: now })
      .eq("id", r.id);
    if (error) setBanner(dbErrorText(error, "Не удалось обновить заявку"));
    await loadData(objectId);
    setBusy(false);
  }

  /** Шаг заявки по цепочке: что делать дальше и какими полями это сопровождается. */
  function advance(r: SupplyRequest) {
    if (!today) return;
    const from = SUPPLY_STATUS_LABEL[r.status];
    if (r.status === "draft") {
      patchRequest(r, { status: "pricing" }, `Статус: ${from} → ${SUPPLY_STATUS_LABEL.pricing}`);
    } else if (r.status === "pricing") {
      if (!r.supplier_id) {
        setBanner("Чтобы согласовать заявку, выберите одно из предложений поставщиков или укажите поставщика в карточке.");
        return;
      }
      patchRequest(r, { status: "approved" }, `Статус: ${from} → ${SUPPLY_STATUS_LABEL.approved}`);
    } else if (r.status === "approved") {
      patchRequest(
        r,
        { status: "ordered", order_date: r.order_date || today },
        `Статус: ${from} → ${SUPPLY_STATUS_LABEL.ordered}${r.order_date ? "" : `; дата заказа ${fmtDate(today)}`}`
      );
    } else if (r.status === "ordered") {
      patchRequest(
        r,
        { status: "delivered", delivery_fact: r.delivery_fact || today },
        `Статус: ${from} → ${SUPPLY_STATUS_LABEL.delivered}; получено ${fmtDate(r.delivery_fact || today)}`
      );
    }
  }

  const ADVANCE_LABEL: Partial<Record<SupplyStatus, string>> = {
    draft: "Начать сбор предложений",
    pricing: "Согласовать",
    approved: "Заказать",
    ordered: "Принять поставку",
  };

  async function deleteRequest(id: string) {
    const { error } = await supabase.from("supply_requests").delete().eq("id", id);
    if (error) setBanner(dbErrorText(error, "Не удалось удалить заявку"));
    else {
      if (detailId === id) setDetailId(null);
      await loadData(objectId);
    }
    setPendingDeleteId(null);
  }

  /* ------------------------------ Предложения ------------------------------ */

  async function addOffer(r: SupplyRequest) {
    const price = numOrNull(offerForm.price);
    if (!offerForm.supplierId && !offerForm.supplierName.trim()) {
      setBanner("Выберите поставщика из базы или впишите его название.");
      return;
    }
    if (price === null || Number.isNaN(price) || price < 0) {
      setBanner("Укажите цену предложения — неотрицательное число.");
      return;
    }
    setBusy(true);
    const now = new Date().toISOString();
    const name = offerForm.supplierId ? supplierName(offerForm.supplierId) : offerForm.supplierName.trim();
    const { error } = await supabase.from("supply_offers").insert({
      request_id: r.id,
      supplier_id: offerForm.supplierId || null,
      supplier_name: offerForm.supplierId ? null : offerForm.supplierName.trim(),
      price,
      note: offerForm.note.trim() || null,
      history: [{ at: now, text: "Предложение добавлено" }],
      created_at: now,
      updated_at: now,
    });
    if (error) {
      setBanner(dbErrorText(error, "Не удалось добавить предложение"));
      setBusy(false);
      return;
    }
    // Первое предложение само переводит заявку в «Сбор предложений» — иначе снабженцу
    // пришлось бы отдельно жать кнопку, которая ничего не добавляет.
    const extra = r.status === "draft" ? `; статус: ${SUPPLY_STATUS_LABEL.draft} → ${SUPPLY_STATUS_LABEL.pricing}` : "";
    await supabase
      .from("supply_requests")
      .update({
        ...(r.status === "draft" ? { status: "pricing" } : {}),
        history: [...(r.history || []), { at: now, text: `Предложение: ${name}, ${fmtMoney(price)}${extra}` }],
        updated_at: now,
      })
      .eq("id", r.id);
    setOfferForm(EMPTY_OFFER_FORM);
    await loadData(objectId);
    setBusy(false);
  }

  /**
   * Выбор предложения — это и есть согласование: поставщик и сумма уходят в заявку.
   * Если поставщика в базе нет, он заводится туда автоматически — иначе у заявки
   * не было бы, на кого считать «% поставок в срок».
   */
  async function chooseOffer(r: SupplyRequest, o: SupplyOffer) {
    setBusy(true);
    let supplierId = o.supplier_id;
    const now = new Date().toISOString();
    if (!supplierId) {
      const name = (o.supplier_name || "").trim();
      const existing = suppliers.find((s) => s.name.trim().toLowerCase() === name.toLowerCase());
      if (existing) {
        supplierId = existing.id;
      } else {
        const { data, error } = await supabase
          .from("suppliers")
          .insert({ name, history: [{ at: now, text: "Заведён из предложения по заявке" }], created_at: now, updated_at: now })
          .select()
          .single();
        if (error || !data) {
          setBanner(dbErrorText(error, "Не удалось завести поставщика в базу"));
          setBusy(false);
          return;
        }
        supplierId = (data as Supplier).id;
      }
      await supabase.from("supply_offers").update({ supplier_id: supplierId, updated_at: now }).eq("id", o.id);
    }
    const name = o.supplier_id ? supplierName(o.supplier_id) : o.supplier_name || "—";
    const toApproved = r.status === "draft" || r.status === "pricing";
    await patchRequest(
      r,
      {
        supplier_id: supplierId,
        order_amount: o.price,
        ...(toApproved ? { status: "approved" as SupplyStatus } : {}),
      },
      `Выбрано предложение: ${name}, ${fmtMoney(o.price)}${
        toApproved ? `; статус: ${SUPPLY_STATUS_LABEL[r.status]} → ${SUPPLY_STATUS_LABEL.approved}` : ""
      }`
    );
    setBusy(false);
  }

  async function deleteOffer(id: string) {
    const { error } = await supabase.from("supply_offers").delete().eq("id", id);
    if (error) setBanner(dbErrorText(error, "Не удалось удалить предложение"));
    else await loadData(objectId);
    setPendingDeleteOfferId(null);
  }

  /* ------------------------------ Поставщики ------------------------------ */

  function openSupPanel(id: string | null) {
    setEditingSupId(id);
    const s = id ? suppliers.find((x) => x.id === id) || null : null;
    setSupForm(supplierToForm(s));
    setSupPanelOpen(true);
  }
  function closeSupPanel() {
    setSupPanelOpen(false);
    setEditingSupId(null);
  }

  async function saveSupplier() {
    if (!supForm.name.trim()) {
      setBanner("Укажите название поставщика.");
      return;
    }
    const rating = numOrNull(supForm.rating);
    if (Number.isNaN(rating) || (rating !== null && (rating < 0 || rating > 5))) {
      setBanner("Рейтинг — число от 0 до 5.");
      return;
    }
    setBanner(null);
    setSupSaving(true);
    const now = new Date().toISOString();
    const payload = {
      name: supForm.name.trim(),
      contact_person: supForm.contactPerson.trim() || null,
      phone: supForm.phone.trim() || null,
      email: supForm.email.trim() || null,
      rating,
      payment_terms: supForm.paymentTerms.trim() || null,
      note: supForm.note.trim() || null,
      updated_at: now,
    };
    if (editingSupId) {
      const old = suppliers.find((x) => x.id === editingSupId) || null;
      const o = supplierToForm(old);
      const parts: string[] = [];
      (Object.keys(SUPPLIER_FIELD_LABEL) as (keyof SupplierForm)[]).forEach((k) => {
        const ov = o[k].trim();
        const nv = supForm[k].trim();
        if (ov !== nv) parts.push(`${SUPPLIER_FIELD_LABEL[k]}: ${ov || "—"} → ${nv || "—"}`);
      });
      const history: HistoryEntry[] = [
        ...(old?.history || []),
        { at: now, text: parts.join("; ") || "Данные сохранены без изменений" },
      ];
      const { error } = await supabase.from("suppliers").update({ ...payload, history }).eq("id", editingSupId);
      if (error) setBanner(dbErrorText(error, "Не удалось сохранить поставщика"));
      else {
        closeSupPanel();
        await loadData(objectId);
      }
    } else {
      const { error } = await supabase
        .from("suppliers")
        .insert({ ...payload, created_at: now, history: [{ at: now, text: "Поставщик добавлен" }] });
      if (error) setBanner(dbErrorText(error, "Не удалось добавить поставщика"));
      else {
        closeSupPanel();
        await loadData(objectId);
      }
    }
    setSupSaving(false);
  }

  async function deleteSupplier(id: string) {
    const { error } = await supabase.from("suppliers").delete().eq("id", id);
    if (error) setBanner(dbErrorText(error, "Не удалось удалить поставщика"));
    else {
      if (supDetailId === id) setSupDetailId(null);
      await loadData(objectId);
    }
    setSupPendingDeleteId(null);
  }

  /* ------------------------------ Рендер: заявки ------------------------------ */

  function renderHistory(history: HistoryEntry[]) {
    const list = (history || []).slice().reverse();
    return list.length ? (
      <ul className="history-list">
        {list.map((h, i) => (
          <li key={i}>
            <time>{fmtDateTime(h.at)}</time>
            {h.text}
          </li>
        ))}
      </ul>
    ) : (
      <p className="hint">Истории изменений пока нет.</p>
    );
  }

  function renderRequestDetail(r: SupplyRequest) {
    const list = (offersByRequest.get(r.id) || []).slice().sort((a, b) => Number(a.price ?? Infinity) - Number(b.price ?? Infinity));
    const best = list.find((o) => o.price !== null);
    const closed = r.status === "delivered" || r.status === "cancelled";
    return (
      <div className="detail" onClick={(e) => e.stopPropagation()}>
        <div className="detail-block">
          <h4>Заявка</h4>
          <dl>
            <dt>Материал</dt>
            <dd>{r.material_name}</dd>
            <dt>Количество</dt>
            <dd className="mono">{r.quantity != null ? `${fmtNum(r.quantity, 3)} ${r.unit || ""}`.trim() : "—"}</dd>
            <dt>Этап графика</dt>
            <dd>{taskName(r.task_id)}</dd>
            <dt>Нужно к</dt>
            <dd className="mono">{fmtDate(r.needed_by)}</dd>
            <dt>Поставщик</dt>
            <dd>{supplierName(r.supplier_id)}</dd>
            <dt>Сумма заказа</dt>
            <dd className="mono">{fmtMoney(r.order_amount)}</dd>
            <dt>Дата заказа</dt>
            <dd className="mono">{fmtDate(r.order_date)}</dd>
            <dt>Доставка</dt>
            <dd className="mono">
              срок {fmtDate(r.delivery_due)} · получено {fmtDate(r.delivery_fact)}
            </dd>
            <dt>Примечание</dt>
            <dd>{r.note || "—"}</dd>
          </dl>
          {neededLate(r) && (
            <p className="hint hint-warn">
              Доставка обещана позже, чем материал нужен на площадке ({fmtDate(r.needed_by)}).
            </p>
          )}
          <div className="detail-actions">
            {ADVANCE_LABEL[r.status] && (
              <button className="btn btn-sm btn-primary" style={{ marginLeft: 0 }} disabled={busy} onClick={() => advance(r)}>
                {ADVANCE_LABEL[r.status]}
              </button>
            )}
            <button className="btn btn-sm btn-ghost" onClick={() => openPanel(r.id)}>
              Изменить
            </button>
            {!closed && (
              <button
                className="btn btn-sm btn-ghost"
                disabled={busy}
                onClick={() =>
                  patchRequest(r, { status: "cancelled" }, `Статус: ${SUPPLY_STATUS_LABEL[r.status]} → ${SUPPLY_STATUS_LABEL.cancelled}`)
                }
              >
                Отменить
              </button>
            )}
            {r.status === "cancelled" && (
              <button
                className="btn btn-sm btn-ghost"
                disabled={busy}
                onClick={() => patchRequest(r, { status: "draft" }, `Статус: ${SUPPLY_STATUS_LABEL.cancelled} → ${SUPPLY_STATUS_LABEL.draft}`)}
              >
                Вернуть в работу
              </button>
            )}
            {pendingDeleteId === r.id ? (
              <button className="btn btn-sm btn-danger" onClick={() => deleteRequest(r.id)}>
                Точно удалить?
              </button>
            ) : (
              <button className="btn btn-sm btn-ghost" onClick={() => setPendingDeleteId(r.id)}>
                Удалить
              </button>
            )}
          </div>
        </div>
        <div className="detail-block">
          <h4>Предложения поставщиков</h4>
          {list.length === 0 ? (
            <p className="hint" style={{ marginTop: 0 }}>Предложений пока нет.</p>
          ) : (
            <ul className="history-list" style={{ maxHeight: "none" }}>
              {list.map((o) => {
                const chosen = !!r.supplier_id && o.supplier_id === r.supplier_id && Number(o.price) === Number(r.order_amount);
                return (
                  <li key={o.id}>
                    <b>{o.supplier_id ? supplierName(o.supplier_id) : o.supplier_name || "—"}</b>{" "}
                    <span className="mono">{fmtMoney(o.price)}</span>
                    {best && best.id === o.id && list.length > 1 && <span className="dev-words"> · дешевле всех</span>}
                    {chosen && <span className="dev-words"> · выбрано</span>}
                    {o.note && <time>{o.note}</time>}
                    {!closed && (
                      <span style={{ display: "flex", gap: 6, marginTop: 4 }}>
                        {!chosen && (
                          <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => chooseOffer(r, o)}>
                            Выбрать
                          </button>
                        )}
                        {pendingDeleteOfferId === o.id ? (
                          <button className="btn btn-sm btn-danger" onClick={() => deleteOffer(o.id)}>
                            Точно удалить?
                          </button>
                        ) : (
                          <button className="btn btn-sm btn-ghost" onClick={() => setPendingDeleteOfferId(o.id)}>
                            Удалить
                          </button>
                        )}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {!closed && (
            <div className="accept-form" style={{ padding: "12px 0 0", marginTop: 10 }}>
              <div className="field-row">
                <div className="field">
                  <label>Поставщик из базы</label>
                  <select
                    value={offerForm.supplierId}
                    onChange={(e) => setOfferForm({ ...offerForm, supplierId: e.target.value })}
                  >
                    <option value="">— нет в базе —</option>
                    {suppliers.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>или название</label>
                  <input
                    type="text"
                    disabled={!!offerForm.supplierId}
                    placeholder="ООО «Стальторг»"
                    value={offerForm.supplierName}
                    onChange={(e) => setOfferForm({ ...offerForm, supplierName: e.target.value })}
                  />
                </div>
              </div>
              <div className="field-row">
                <div className="field">
                  <label>Цена за всю заявку, ₽</label>
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={offerForm.price}
                    onChange={(e) => setOfferForm({ ...offerForm, price: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label>Условия / срок</label>
                  <input
                    type="text"
                    placeholder="доставка 5 дней, 50% предоплата"
                    value={offerForm.note}
                    onChange={(e) => setOfferForm({ ...offerForm, note: e.target.value })}
                  />
                </div>
              </div>
              <div className="accept-actions">
                <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => addOffer(r)}>
                  + Добавить предложение
                </button>
              </div>
            </div>
          )}
          <h4 style={{ marginTop: 16 }}>История изменений</h4>
          {renderHistory(r.history)}
        </div>
      </div>
    );
  }

  function toggleRequest(id: string) {
    setDetailId((cur) => (cur === id ? null : id));
    setPendingDeleteId(null);
    setPendingDeleteOfferId(null);
    setOfferForm(EMPTY_OFFER_FORM);
  }

  function renderRequests() {
    const emptyText = !objectId
      ? "Сначала создайте объект в модуле «Объекты»."
      : requests.length === 0
      ? "Заявок на материалы по объекту пока нет — создайте первую."
      : "Ничего не найдено по заданным условиям.";
    return (
      <>
        {summary && (
          <div className="stats">
            <div className="stat-total">
              <span className="n">{summary.active}</span>
              <span className="l">{plural(summary.active, "заявка в работе", "заявки в работе", "заявок в работе")}</span>
            </div>
            <div className="chip-row">
              <span className="chip st-bad">
                <span className="n">{summary.overdueDelivery}</span> просрочена доставка
              </span>
              <span className="chip st-good">
                <span className="n">{summary.delivered}</span> доставлено
              </span>
              <span className="chip st-neutral">
                <span className="n">{summary.total}</span> всего
              </span>
            </div>
          </div>
        )}
        <div className="toolbar">
          <input
            className="search"
            type="text"
            placeholder="Поиск по материалу, поставщику, этапу…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select className="filter" value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
            <option value="open">В работе</option>
            <option value="">Все статусы</option>
            {STATUS_ORDER.map((s) => (
              <option key={s} value={s}>
                {SUPPLY_STATUS_LABEL[s]}
              </option>
            ))}
          </select>
          <button className="btn btn-primary" onClick={() => openPanel(null)} disabled={!objectId}>
            + Заявка на материал
          </button>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Материал</th>
                <th>Кол-во</th>
                <th>Этап</th>
                <th>Нужно к</th>
                <th>Поставщик</th>
                <th>Сумма</th>
                <th>Доставка</th>
                <th>Статус</th>
              </tr>
            </thead>
            <tbody>
              {loadingData ? (
                <tr>
                  <td colSpan={8}>
                    <div className="empty-state">Загрузка…</div>
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={8}>
                    <div className="empty-state">{emptyText}</div>
                  </td>
                </tr>
              ) : (
                filtered.map((r) => {
                  const late = deliveryLate(r);
                  const offersCount = (offersByRequest.get(r.id) || []).length;
                  return (
                    <Fragment key={r.id}>
                      <tr className="obj-row" onClick={dbl(r.id, () => toggleRequest(r.id))} title={DOUBLE_TAP_HINT}>
                        <td className="name-cell">
                          {r.material_name}
                          {offersCount > 0 && (
                            <div className="dev-words" style={{ fontWeight: 400 }}>
                              {offersCount} {plural(offersCount, "предложение", "предложения", "предложений")}
                            </div>
                          )}
                        </td>
                        <td className="mono">{r.quantity != null ? `${fmtNum(r.quantity, 3)} ${r.unit || ""}`.trim() : "—"}</td>
                        <td className="addr-cell">{taskName(r.task_id)}</td>
                        <td className={`mono${neededLate(r) ? " is-neg" : ""}`}>{fmtDate(r.needed_by)}</td>
                        <td>{supplierName(r.supplier_id)}</td>
                        <td className="mono">{fmtMoney(r.order_amount)}</td>
                        <td className={`mono${late ? " is-neg" : ""}`} title={late ? "Срок доставки прошёл, материал не получен" : undefined}>
                          {r.delivery_fact ? `✓ ${fmtDate(r.delivery_fact)}` : fmtDate(r.delivery_due)}
                        </td>
                        <td>
                          <span className={`status-pill ${late ? "st-bad" : SUPPLY_STATUS_CLASS[r.status]}`}>
                            {late ? "Доставка просрочена" : SUPPLY_STATUS_LABEL[r.status]}
                          </span>
                        </td>
                      </tr>
                      {detailId === r.id && (
                        <tr className="detail-row">
                          <td colSpan={8}>{renderRequestDetail(r)}</td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <div className="cards">
          {loadingData ? (
            <div className="empty-state">Загрузка…</div>
          ) : filtered.length === 0 ? (
            <div className="empty-state">{emptyText}</div>
          ) : (
            filtered.map((r) => {
              const late = deliveryLate(r);
              return (
                <div className="obj-card" key={r.id} onClick={dbl(r.id, () => toggleRequest(r.id))} title={DOUBLE_TAP_HINT}>
                  <div className="row1">
                    <div>
                      <div className="cname">{r.material_name}</div>
                      <div className="caddr">{taskName(r.task_id)}</div>
                    </div>
                    <span className={`status-pill ${late ? "st-bad" : SUPPLY_STATUS_CLASS[r.status]}`}>
                      {late ? "Доставка просрочена" : SUPPLY_STATUS_LABEL[r.status]}
                    </span>
                  </div>
                  <div className="cmeta">
                    <span className="mono">{r.quantity != null ? `${fmtNum(r.quantity, 3)} ${r.unit || ""}`.trim() : "—"}</span>
                    <span>нужно к {fmtDate(r.needed_by)}</span>
                    {r.supplier_id && <span>{supplierName(r.supplier_id)}</span>}
                    {r.order_amount != null && <span className="mono">{fmtMoney(r.order_amount)}</span>}
                  </div>
                  {detailId === r.id && renderRequestDetail(r)}
                </div>
              );
            })
          )}
        </div>
      </>
    );
  }

  /* ------------------------------ Рендер: поставщики ------------------------------ */

  function renderSupplierDetail(s: Supplier) {
    const st = supplierStats.get(s.id);
    const reqs = allRequests.filter((r) => r.supplier_id === s.id);
    return (
      <div className="detail" onClick={(e) => e.stopPropagation()}>
        <div className="detail-block">
          <h4>Поставщик</h4>
          <dl>
            <dt>Контакт</dt>
            <dd>{s.contact_person || "—"}</dd>
            <dt>Телефон</dt>
            <dd className="mono">{s.phone || "—"}</dd>
            <dt>Email</dt>
            <dd>{s.email || "—"}</dd>
            <dt>Рейтинг</dt>
            <dd className="mono">{s.rating != null ? `${fmtNum(s.rating, 1)} из 5` : "—"}</dd>
            <dt>Поставок в срок</dt>
            <dd className="mono">
              {st && st.onTimePercent !== null ? `${fmtPercent(st.onTimePercent)} (${st.onTime} из ${st.delivered})` : "нет доставленных заявок"}
            </dd>
            <dt>Заявок всего</dt>
            <dd className="mono">{reqs.length}</dd>
            <dt>Условия оплаты</dt>
            <dd>{s.payment_terms || "—"}</dd>
            <dt>Примечание</dt>
            <dd>{s.note || "—"}</dd>
          </dl>
          <div className="detail-actions">
            <button className="btn btn-sm btn-ghost" onClick={() => openSupPanel(s.id)}>
              Изменить
            </button>
            {supPendingDeleteId === s.id ? (
              <button className="btn btn-sm btn-danger" onClick={() => deleteSupplier(s.id)}>
                Точно удалить?
              </button>
            ) : (
              <button className="btn btn-sm btn-ghost" onClick={() => setSupPendingDeleteId(s.id)}>
                Удалить
              </button>
            )}
          </div>
        </div>
        <div className="detail-block">
          <h4>История изменений</h4>
          {renderHistory(s.history)}
        </div>
      </div>
    );
  }

  function renderSuppliers() {
    const q = search.trim().toLowerCase();
    const list = suppliers.filter((s) =>
      q ? `${s.name} ${s.contact_person || ""} ${s.phone || ""}`.toLowerCase().includes(q) : true
    );
    const onTimeCls = (p: number | null) => (p === null ? "st-neutral" : p >= 90 ? "st-good" : p >= 70 ? "st-warn" : "st-bad");
    return (
      <>
        <div className="stats">
          <div className="stat-total">
            <span className="n">{suppliers.length}</span>
            <span className="l">{plural(suppliers.length, "поставщик в базе", "поставщика в базе", "поставщиков в базе")}</span>
          </div>
        </div>
        <div className="toolbar">
          <input
            className="search"
            type="text"
            placeholder="Поиск по названию, контакту, телефону…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button className="btn btn-primary" onClick={() => openSupPanel(null)}>
            + Поставщик
          </button>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Поставщик</th>
                <th>Контакт</th>
                <th>Телефон</th>
                <th>Рейтинг</th>
                <th>В срок</th>
                <th>Условия оплаты</th>
              </tr>
            </thead>
            <tbody>
              {list.length === 0 ? (
                <tr>
                  <td colSpan={6}>
                    <div className="empty-state">
                      {loadingData ? "Загрузка…" : suppliers.length === 0 ? "Поставщиков пока нет — добавьте первого." : "Ничего не найдено."}
                    </div>
                  </td>
                </tr>
              ) : (
                list.map((s) => {
                  const st = supplierStats.get(s.id);
                  const p = st?.onTimePercent ?? null;
                  return (
                    <Fragment key={s.id}>
                      <tr className="obj-row" onClick={dbl(s.id, () => setSupDetailId((c) => (c === s.id ? null : s.id)))} title={DOUBLE_TAP_HINT}>
                        <td className="name-cell">{s.name}</td>
                        <td>{s.contact_person || "—"}</td>
                        <td className="mono">{s.phone || "—"}</td>
                        <td className="mono">{s.rating != null ? fmtNum(s.rating, 1) : "—"}</td>
                        <td>
                          <span className={`status-pill ${onTimeCls(p)}`}>
                            {p === null ? "нет данных" : `${fmtPercent(p)} · ${st!.delivered}`}
                          </span>
                        </td>
                        <td className="addr-cell">{s.payment_terms || "—"}</td>
                      </tr>
                      {supDetailId === s.id && (
                        <tr className="detail-row">
                          <td colSpan={6}>{renderSupplierDetail(s)}</td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        <div className="cards">
          {list.length === 0 ? (
            <div className="empty-state">{suppliers.length === 0 ? "Поставщиков пока нет — добавьте первого." : "Ничего не найдено."}</div>
          ) : (
            list.map((s) => {
              const st = supplierStats.get(s.id);
              const p = st?.onTimePercent ?? null;
              return (
                <div className="obj-card" key={s.id} onClick={dbl(s.id, () => setSupDetailId((c) => (c === s.id ? null : s.id)))} title={DOUBLE_TAP_HINT}>
                  <div className="row1">
                    <div>
                      <div className="cname">{s.name}</div>
                      <div className="caddr">{[s.contact_person, s.phone].filter(Boolean).join(" · ") || "—"}</div>
                    </div>
                    <span className={`status-pill ${onTimeCls(p)}`}>{p === null ? "нет данных" : `в срок ${fmtPercent(p)}`}</span>
                  </div>
                  <div className="cmeta">
                    {s.rating != null && <span className="mono">рейтинг {fmtNum(s.rating, 1)}</span>}
                    {s.payment_terms && <span>{s.payment_terms}</span>}
                  </div>
                  {supDetailId === s.id && renderSupplierDetail(s)}
                </div>
              );
            })
          )}
        </div>
      </>
    );
  }

  const selectedObject = objects.find((o) => o.id === objectId) || null;

  return (
    <div>
      {banner && (
        <div className="banner show" onClick={() => setBanner(null)} role="status">
          {banner}
        </div>
      )}
      {schemaMissing && <SchemaSetup onRecheck={() => loadData(objectId)} />}

      <div className="obj-picker">
        <CurrentObject name={objects.find((o) => o.id === objectId)?.name ?? null} loading={loadingObjects} />
        {selectedObject && view === "requests" && <span className="obj-picker-meta">{selectedObject.address}</span>}
        {view === "suppliers" && <span className="obj-picker-meta">база поставщиков общая для всех объектов</span>}
      </div>

      <div className="toolbar" style={{ paddingBottom: 0 }}>
        <div className="seg" role="tablist" aria-label="Раздел снабжения">
          <button
            className={`seg-btn${view === "requests" ? " active" : ""}`}
            onClick={() => {
              setView("requests");
              setSearch("");
            }}
          >
            Заявки на материалы
          </button>
          <button
            className={`seg-btn${view === "suppliers" ? " active" : ""}`}
            onClick={() => {
              setView("suppliers");
              setSearch("");
            }}
          >
            Поставщики
          </button>
        </div>
      </div>

      {view === "requests" ? renderRequests() : renderSuppliers()}

      {/* ---- Панель заявки ---- */}
      <div className={`overlay${panelOpen ? " show" : ""}`} onClick={closePanel} />
      <div className={`panel${panelOpen ? " show" : ""}`}>
        <div className="panel-head">
          <h3>{editingId ? "Изменить заявку" : "Новая заявка на материал"}</h3>
          <button className="panel-close" aria-label="Закрыть" onClick={closePanel}>
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
              value={form.materialName}
              onChange={(e) => setForm({ ...form, materialName: e.target.value })}
            />
          </div>
          <div className="field-row">
            <div className="field">
              <label>Количество</label>
              <input
                type="number"
                min={0}
                step="0.001"
                value={form.quantity}
                onChange={(e) => setForm({ ...form, quantity: e.target.value })}
              />
            </div>
            <div className="field">
              <label>Ед. изм.</label>
              <input
                type="text"
                list="atr-units-supply"
                placeholder="т"
                value={form.unit}
                onChange={(e) => setForm({ ...form, unit: e.target.value })}
              />
              <datalist id="atr-units-supply">
                {UNITS.map((u) => (
                  <option key={u} value={u} />
                ))}
              </datalist>
            </div>
          </div>
          <div className="field">
            <label>Этап графика</label>
            <select value={form.taskId} onChange={(e) => pickTask(e.target.value)}>
              <option value="">— без привязки —</option>
              {leaves.map((n) => (
                <option key={n.task.id} value={n.task.id}>
                  {n.task.name}
                  {n.startPlan ? ` (с ${fmtDate(n.startPlan)})` : ""}
                </option>
              ))}
            </select>
            <p className="hint">Выбор этапа подставит единицу и срок потребности — плановое начало работ.</p>
          </div>
          <div className="field-row">
            <div className="field">
              <label>Нужно на площадке к</label>
              <input type="date" value={form.neededBy} onChange={(e) => setForm({ ...form, neededBy: e.target.value })} />
            </div>
            <div className="field">
              <label>Статус</label>
              <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as SupplyStatus })}>
                {STATUS_ORDER.map((s) => (
                  <option key={s} value={s}>
                    {SUPPLY_STATUS_LABEL[s]}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="field">
            <label>Поставщик</label>
            <select value={form.supplierId} onChange={(e) => setForm({ ...form, supplierId: e.target.value })}>
              <option value="">— не выбран —</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field-row">
            <div className="field">
              <label>Сумма заказа, ₽</label>
              <input
                type="number"
                min={0}
                step="0.01"
                value={form.orderAmount}
                onChange={(e) => setForm({ ...form, orderAmount: e.target.value })}
              />
            </div>
            <div className="field">
              <label>Дата заказа</label>
              <input type="date" value={form.orderDate} onChange={(e) => setForm({ ...form, orderDate: e.target.value })} />
            </div>
          </div>
          <div className="field-row">
            <div className="field">
              <label>Срок доставки</label>
              <input type="date" value={form.deliveryDue} onChange={(e) => setForm({ ...form, deliveryDue: e.target.value })} />
            </div>
            <div className="field">
              <label>Получено (факт)</label>
              <input type="date" value={form.deliveryFact} onChange={(e) => setForm({ ...form, deliveryFact: e.target.value })} />
            </div>
          </div>
          <div className="field">
            <label>Примечание</label>
            <input type="text" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </div>
        </div>
        <div className="panel-foot">
          <button className="btn btn-ghost" onClick={closePanel}>
            Отмена
          </button>
          <button className="btn btn-primary" onClick={saveRequest} disabled={saving}>
            {saving ? "Сохранение…" : "Сохранить"}
          </button>
        </div>
      </div>

      {/* ---- Панель поставщика ---- */}
      <div className={`overlay${supPanelOpen ? " show" : ""}`} onClick={closeSupPanel} />
      <div className={`panel${supPanelOpen ? " show" : ""}`}>
        <div className="panel-head">
          <h3>{editingSupId ? "Изменить поставщика" : "Новый поставщик"}</h3>
          <button className="panel-close" aria-label="Закрыть" onClick={closeSupPanel}>
            ✕
          </button>
        </div>
        <div className="panel-body">
          <div className="field">
            <label>
              Название <span className="req">*</span>
            </label>
            <input
              type="text"
              placeholder="ООО «Металлоснаб»"
              value={supForm.name}
              onChange={(e) => setSupForm({ ...supForm, name: e.target.value })}
            />
          </div>
          <div className="field">
            <label>Контактное лицо</label>
            <input
              type="text"
              value={supForm.contactPerson}
              onChange={(e) => setSupForm({ ...supForm, contactPerson: e.target.value })}
            />
          </div>
          <div className="field-row">
            <div className="field">
              <label>Телефон</label>
              <input type="tel" value={supForm.phone} onChange={(e) => setSupForm({ ...supForm, phone: e.target.value })} />
            </div>
            <div className="field">
              <label>Email</label>
              <input type="email" value={supForm.email} onChange={(e) => setSupForm({ ...supForm, email: e.target.value })} />
            </div>
          </div>
          <div className="field">
            <label>Рейтинг, 0…5</label>
            <input
              type="number"
              min={0}
              max={5}
              step="0.5"
              value={supForm.rating}
              onChange={(e) => setSupForm({ ...supForm, rating: e.target.value })}
            />
            <p className="hint">Ваша оценка. «% поставок в срок» считается сам — по доставленным заявкам.</p>
          </div>
          <div className="field">
            <label>Условия оплаты</label>
            <input
              type="text"
              placeholder="напр. 50% предоплата, 50% по факту"
              value={supForm.paymentTerms}
              onChange={(e) => setSupForm({ ...supForm, paymentTerms: e.target.value })}
            />
          </div>
          <div className="field">
            <label>Примечание</label>
            <input type="text" value={supForm.note} onChange={(e) => setSupForm({ ...supForm, note: e.target.value })} />
          </div>
        </div>
        <div className="panel-foot">
          <button className="btn btn-ghost" onClick={closeSupPanel}>
            Отмена
          </button>
          <button className="btn btn-primary" onClick={saveSupplier} disabled={supSaving}>
            {supSaving ? "Сохранение…" : "Сохранить"}
          </button>
        </div>
      </div>
    </div>
  );
}

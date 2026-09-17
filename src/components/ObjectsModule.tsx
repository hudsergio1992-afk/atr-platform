"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import {
  ConstructionObject,
  HistoryEntry,
  ObjectStatus,
  ObjectType,
  STATUS_CLASS,
  STATUS_LABEL,
  TYPE_LABEL,
} from "@/lib/types";

interface FormState {
  name: string;
  address: string;
  type: ObjectType;
  contractNumber: string;
  contractDate: string;
  contractAmount: string;
  startDate: string;
  endDatePlanned: string;
  status: ObjectStatus;
}

const EMPTY_FORM: FormState = {
  name: "",
  address: "",
  type: "construction",
  contractNumber: "",
  contractDate: "",
  contractAmount: "",
  startDate: "",
  endDatePlanned: "",
  status: "planning",
};

const FIELD_LABEL: Record<keyof FormState, string> = {
  name: "Название",
  address: "Адрес",
  type: "Тип",
  contractNumber: "№ договора",
  contractDate: "Дата договора",
  contractAmount: "Сумма договора",
  startDate: "Начало",
  endDatePlanned: "Окончание",
  status: "Статус",
};

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const p = iso.split("-");
  if (p.length !== 3) return iso;
  return `${p[2]}.${p[1]}.${p[0]}`;
}

function fmtMoney(n: number | string | null | undefined): string {
  if (n === undefined || n === null || n === "") return "—";
  const num = Number(n);
  if (isNaN(num)) return "—";
  return num.toLocaleString("ru-RU", { maximumFractionDigits: 0 }) + " ₽";
}

function fmtDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function toForm(o: ConstructionObject | null): FormState {
  if (!o) return { ...EMPTY_FORM };
  return {
    name: o.name,
    address: o.address,
    type: o.type,
    contractNumber: o.contract_number || "",
    contractDate: o.contract_date || "",
    contractAmount: o.contract_amount != null ? String(o.contract_amount) : "",
    startDate: o.start_date || "",
    endDatePlanned: o.end_date_planned || "",
    status: o.status,
  };
}

function diffText(old: ConstructionObject | null, form: FormState): string {
  const parts: string[] = [];
  const ovFor = (k: keyof FormState) => {
    if (!old) return undefined;
    switch (k) {
      case "contractNumber": return old.contract_number || "";
      case "contractDate": return old.contract_date || "";
      case "contractAmount": return old.contract_amount != null ? String(old.contract_amount) : "";
      case "startDate": return old.start_date || "";
      case "endDatePlanned": return old.end_date_planned || "";
      default: return (old as unknown as Record<string, string>)[k];
    }
  };
  (Object.keys(FIELD_LABEL) as (keyof FormState)[]).forEach((k) => {
    const ov = ovFor(k) ?? "";
    const nv = form[k] ?? "";
    if (ov === nv) return;
    const label = FIELD_LABEL[k];
    const disp = (v: string) => {
      if (k === "contractAmount") return fmtMoney(v);
      if (k === "type") return TYPE_LABEL[v as ObjectType] || v || "—";
      if (k === "status") return STATUS_LABEL[v as ObjectStatus] || v || "—";
      if (k === "contractDate" || k === "startDate" || k === "endDatePlanned") return fmtDate(v) === "—" ? (v || "—") : fmtDate(v);
      return v || "—";
    };
    parts.push(`${label}: ${disp(String(ov))} → ${disp(String(nv))}`);
  });
  return parts.join("; ");
}

export default function ObjectsModule() {
  const [objects, setObjects] = useState<ConstructionObject[]>([]);
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [filterType, setFilterType] = useState<string>("");
  const [filterStatus, setFilterStatus] = useState<string>("");

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  const [panelOpen, setPanelOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    const { data, error } = await supabase
      .from("objects")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) {
      setBanner("Не удалось загрузить объекты: " + error.message);
    } else {
      setObjects((data as ConstructionObject[]) || []);
    }
    setLoading(false);
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load() sets state after an await, not synchronously
    load();
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return objects.filter((o) => {
      if (filterType && o.type !== filterType) return false;
      if (filterStatus && o.status !== filterStatus) return false;
      if (q) {
        const hay = `${o.name || ""} ${o.address || ""}`.toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
  }, [objects, search, filterType, filterStatus]);

  const counts = useMemo(() => {
    const c: Record<ObjectStatus, number> = { planning: 0, active: 0, paused: 0, done: 0 };
    objects.forEach((o) => {
      if (c[o.status] !== undefined) c[o.status]++;
    });
    return c;
  }, [objects]);

  function openPanel(id: string | null) {
    setEditingId(id);
    const o = id ? objects.find((x) => x.id === id) || null : null;
    setForm(toForm(o));
    setPanelOpen(true);
  }
  function closePanel() {
    setPanelOpen(false);
    setEditingId(null);
  }

  function toggleRow(id: string) {
    setExpandedId((cur) => (cur === id ? null : id));
    setPendingDeleteId(null);
  }

  async function handleSave() {
    if (!form.name.trim() || !form.address.trim() || !form.type) {
      setBanner("Заполните название, адрес и тип объекта.");
      return;
    }
    setSaving(true);
    const now = new Date().toISOString();
    const payload = {
      name: form.name.trim(),
      address: form.address.trim(),
      type: form.type,
      contract_number: form.contractNumber.trim() || null,
      contract_date: form.contractDate || null,
      contract_amount: form.contractAmount === "" ? null : Number(form.contractAmount),
      start_date: form.startDate || null,
      end_date_planned: form.endDatePlanned || null,
      status: form.status,
      updated_at: now,
    };

    if (editingId) {
      const old = objects.find((x) => x.id === editingId) || null;
      const change = diffText(old, form);
      const history: HistoryEntry[] = old?.history ? [...old.history] : [];
      history.push({ at: now, text: change || "Данные сохранены без изменений" });
      const { error } = await supabase
        .from("objects")
        .update({ ...payload, history })
        .eq("id", editingId);
      if (error) {
        setBanner("Не удалось сохранить изменения: " + error.message);
      } else {
        closePanel();
        await load();
      }
    } else {
      const history: HistoryEntry[] = [{ at: now, text: "Объект создан" }];
      const { error } = await supabase
        .from("objects")
        .insert({ ...payload, created_at: now, history });
      if (error) {
        setBanner("Не удалось создать объект: " + error.message);
      } else {
        closePanel();
        await load();
      }
    }
    setSaving(false);
  }

  async function doDelete(id: string) {
    const { error } = await supabase.from("objects").delete().eq("id", id);
    if (error) {
      setBanner("Не удалось удалить объект: " + error.message);
    } else {
      if (expandedId === id) setExpandedId(null);
      await load();
    }
    setPendingDeleteId(null);
  }

  function renderDetail(o: ConstructionObject) {
    const history = (o.history || []).slice().reverse();
    return (
      <div className="detail">
        <div className="detail-block">
          <h4>Договор и сроки</h4>
          <dl>
            <dt>№ договора</dt>
            <dd className="mono">{o.contract_number || "—"}</dd>
            <dt>Дата договора</dt>
            <dd className="mono">{fmtDate(o.contract_date)}</dd>
            <dt>Сумма</dt>
            <dd className="mono">{fmtMoney(o.contract_amount)}</dd>
            <dt>Начало (план)</dt>
            <dd className="mono">{fmtDate(o.start_date)}</dd>
            <dt>Окончание (план)</dt>
            <dd className="mono">{fmtDate(o.end_date_planned)}</dd>
          </dl>
          <div className="detail-actions">
            <button
              className="btn btn-sm btn-ghost"
              onClick={(e) => {
                e.stopPropagation();
                openPanel(o.id);
              }}
            >
              Изменить
            </button>
            {pendingDeleteId === o.id ? (
              <button
                className="btn btn-sm btn-danger"
                onClick={(e) => {
                  e.stopPropagation();
                  doDelete(o.id);
                }}
              >
                Точно удалить?
              </button>
            ) : (
              <button
                className="btn btn-sm btn-ghost"
                onClick={(e) => {
                  e.stopPropagation();
                  setPendingDeleteId(o.id);
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
            <p style={{ color: "var(--muted)", fontSize: "12.5px", margin: 0 }}>
              Истории изменений пока нет.
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div>
      {banner && <div className="banner show">{banner}</div>}

      <div className="stats">
        <div className="stat-total">
          <span className="n">{loading ? "—" : objects.length}</span>
          <span className="l">объектов всего</span>
        </div>
        <div className="chip-row">
          {(["active", "planning", "paused", "done"] as ObjectStatus[]).map((k) => (
            <span key={k} className={`chip ${STATUS_CLASS[k]}`}>
              <span className="n">{counts[k]}</span> {STATUS_LABEL[k]}
            </span>
          ))}
        </div>
      </div>

      <div className="toolbar">
        <input
          className="search"
          type="text"
          placeholder="Поиск по названию или адресу…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select className="filter" value={filterType} onChange={(e) => setFilterType(e.target.value)}>
          <option value="">Все типы</option>
          <option value="construction">Строительство</option>
          <option value="design">Проектирование</option>
          <option value="reconstruction">Реконструкция</option>
        </select>
        <select className="filter" value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
          <option value="">Все статусы</option>
          <option value="planning">Планирование</option>
          <option value="active">В работе</option>
          <option value="paused">Приостановлен</option>
          <option value="done">Завершён</option>
        </select>
        <button className="btn btn-primary" onClick={() => openPanel(null)}>
          + Добавить объект
        </button>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Название</th>
              <th>Адрес</th>
              <th>Тип</th>
              <th>Договор</th>
              <th>Сумма</th>
              <th>Сроки (план)</th>
              <th>Статус</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={7}>
                  <div className="empty-state">
                    {loading
                      ? "Загрузка…"
                      : objects.length === 0
                      ? "Объектов пока нет — добавьте первый."
                      : "Ничего не найдено по заданным условиям."}
                  </div>
                </td>
              </tr>
            ) : (
              filtered.map((o) => (
                <Fragment key={o.id}>
                  <tr className="obj-row" onClick={() => toggleRow(o.id)}>
                    <td className="name-cell">{o.name}</td>
                    <td className="addr-cell">{o.address}</td>
                    <td>{TYPE_LABEL[o.type] || o.type}</td>
                    <td className="mono">{o.contract_number || "—"}</td>
                    <td className="mono">{fmtMoney(o.contract_amount)}</td>
                    <td className="mono">
                      {fmtDate(o.start_date)}–{fmtDate(o.end_date_planned)}
                    </td>
                    <td>
                      <span className={`status-pill ${STATUS_CLASS[o.status]}`}>
                        {STATUS_LABEL[o.status]}
                      </span>
                    </td>
                  </tr>
                  {expandedId === o.id && (
                    <tr className="detail-row">
                      <td colSpan={7}>{renderDetail(o)}</td>
                    </tr>
                  )}
                </Fragment>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="cards">
        {filtered.length === 0 ? (
          <div className="empty-state">
            {loading
              ? "Загрузка…"
              : objects.length === 0
              ? "Объектов пока нет — добавьте первый."
              : "Ничего не найдено по заданным условиям."}
          </div>
        ) : (
          filtered.map((o) => (
            <div className="obj-card" key={o.id} onClick={() => toggleRow(o.id)}>
              <div className="row1">
                <div>
                  <div className="cname">{o.name}</div>
                  <div className="caddr">{o.address}</div>
                </div>
                <span className={`status-pill ${STATUS_CLASS[o.status]}`}>
                  {STATUS_LABEL[o.status]}
                </span>
              </div>
              <div className="cmeta">
                <span>{TYPE_LABEL[o.type] || o.type}</span>
                <span className="mono">{fmtMoney(o.contract_amount)}</span>
                <span className="mono">
                  {fmtDate(o.start_date)}–{fmtDate(o.end_date_planned)}
                </span>
              </div>
              {expandedId === o.id && renderDetail(o)}
            </div>
          ))
        )}
      </div>

      <div className={`overlay${panelOpen ? " show" : ""}`} onClick={closePanel} />
      <div className={`panel${panelOpen ? " show" : ""}`}>
        <div className="panel-head">
          <h3>{editingId ? "Изменить объект" : "Новый объект"}</h3>
          <button className="panel-close" aria-label="Закрыть" onClick={closePanel}>
            ✕
          </button>
        </div>
        <div className="panel-body">
          <div className="field">
            <label>
              Название объекта <span className="req">*</span>
            </label>
            <input
              type="text"
              placeholder="напр. Зерносушильный комплекс «Отрадная»"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>
          <div className="field">
            <label>
              Адрес <span className="req">*</span>
            </label>
            <input
              type="text"
              placeholder="напр. Краснодарский край, ст. Отрадная"
              value={form.address}
              onChange={(e) => setForm({ ...form, address: e.target.value })}
            />
          </div>
          <div className="field">
            <label>
              Тип объекта <span className="req">*</span>
            </label>
            <select
              value={form.type}
              onChange={(e) => setForm({ ...form, type: e.target.value as ObjectType })}
            >
              <option value="construction">Строительство</option>
              <option value="design">Проектирование</option>
              <option value="reconstruction">Реконструкция</option>
            </select>
          </div>
          <div className="field-row">
            <div className="field">
              <label>№ договора</label>
              <input
                type="text"
                placeholder="04/06/26"
                value={form.contractNumber}
                onChange={(e) => setForm({ ...form, contractNumber: e.target.value })}
              />
            </div>
            <div className="field">
              <label>Дата договора</label>
              <input
                type="date"
                value={form.contractDate}
                onChange={(e) => setForm({ ...form, contractDate: e.target.value })}
              />
            </div>
          </div>
          <div className="field">
            <label>Сумма договора, ₽</label>
            <input
              type="number"
              min={0}
              step="0.01"
              placeholder="0"
              value={form.contractAmount}
              onChange={(e) => setForm({ ...form, contractAmount: e.target.value })}
            />
          </div>
          <div className="field-row">
            <div className="field">
              <label>Начало (план)</label>
              <input
                type="date"
                value={form.startDate}
                onChange={(e) => setForm({ ...form, startDate: e.target.value })}
              />
            </div>
            <div className="field">
              <label>Окончание (план)</label>
              <input
                type="date"
                value={form.endDatePlanned}
                onChange={(e) => setForm({ ...form, endDatePlanned: e.target.value })}
              />
            </div>
          </div>
          <div className="field">
            <label>Статус</label>
            <select
              value={form.status}
              onChange={(e) => setForm({ ...form, status: e.target.value as ObjectStatus })}
            >
              <option value="planning">Планирование</option>
              <option value="active">В работе</option>
              <option value="paused">Приостановлен</option>
              <option value="done">Завершён</option>
            </select>
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

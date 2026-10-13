"use client";

import { useRef, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { dbErrorText } from "@/lib/dbError";
import { BudgetLine, ConstructionObject, HistoryEntry, ScheduleTask, SupplyRequest, BUDGET_SECTION_LABEL } from "@/lib/types";
import { ACTION_LABEL, buildWorkbookPlan, Issue, WorkbookPlan } from "@/lib/importWorkbook";
import { fmtDate, fmtMoney, plural } from "@/lib/format";

interface Props {
  object: ConstructionObject;
  onClose: () => void;
  onDone: (message: string) => void;
}

type Part = "gpr" | "smeta" | "gpm";

function count<T extends { action: string }>(rows: T[]) {
  return {
    create: rows.filter((r) => r.action === "create").length,
    update: rows.filter((r) => r.action === "update").length,
    same: rows.filter((r) => r.action === "same").length,
    locked: rows.filter((r) => r.action === "locked").length,
  };
}

function IssueList({ title, items, cls }: { title: string; items: Issue[]; cls: string }) {
  if (!items.length) return null;
  return (
    <div className={cls}>
      <h4>{title}</h4>
      <ul>
        {items.slice(0, 40).map((e, i) => (
          <li key={i}>
            {e.sheet}
            {e.line ? `, строка ${e.line}` : ""}: {e.text}
          </li>
        ))}
      </ul>
      {items.length > 40 && <p className="hint">…и ещё {items.length - 40}.</p>}
    </div>
  );
}

export default function WorkbookImport({ object, onClose, onDone }: Props) {
  const [plan, setPlan] = useState<WorkbookPlan | null>(null);
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [parts, setParts] = useState<Record<Part, boolean>>({ gpr: true, smeta: true, gpm: true });
  const fileRef = useRef<HTMLInputElement | null>(null);

  async function loadExisting() {
    const [t, b, s] = await Promise.all([
      supabase.from("schedule_tasks").select("*").eq("object_id", object.id),
      supabase.from("budget_lines").select("*").eq("object_id", object.id),
      supabase.from("supply_requests").select("*").eq("object_id", object.id),
    ]);
    const err = t.error || b.error || s.error;
    if (err) throw new Error(dbErrorText(err, "Не удалось прочитать данные объекта"));
    return {
      tasks: (t.data || []) as ScheduleTask[],
      budget: (b.data || []) as BudgetLine[],
      supply: (s.data || []) as SupplyRequest[],
    };
  }

  async function readFile(file: File) {
    setError(null);
    setPlan(null);
    setFileName(file.name);
    setBusy(true);
    try {
      const XLSX = await import("xlsx");
      const book = XLSX.read(await file.arrayBuffer(), { cellDates: true });
      const sheets = book.SheetNames.map((name) => ({
        name,
        matrix: XLSX.utils.sheet_to_json<unknown[]>(book.Sheets[name], { header: 1, raw: true, defval: null, blankrows: true }),
      }));
      const existing = await loadExisting();
      const p = buildWorkbookPlan({ sheets, ...existing });
      if (!p.gpr.found && !p.smeta.found && !p.gpm.found) {
        setError("В файле нет листов книги объекта: «График производства работ», «Коммерческая смета», «График поставки материалов». Возьмите форму АТР-КО-01.");
      } else {
        setPlan(p);
        setParts({
          gpr: p.gpr.found && !p.gpr.errors.length && p.gpr.rows.length > 0,
          smeta: p.smeta.found && !p.smeta.errors.length && p.smeta.lines.length > 0,
          gpm: p.gpm.found && !p.gpm.errors.length && p.gpm.rows.length > 0,
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Файл не прочитан. Сохраните его в Excel как .xlsx и попробуйте снова.");
    }
    setBusy(false);
  }

  async function apply() {
    if (!plan) return;
    setBusy(true);
    setError(null);
    const now = new Date().toISOString();
    const note = (text: string): HistoryEntry => ({ at: now, text: `${text} (книга объекта «${fileName}»)` });
    const done: string[] = [];
    try {
      /* ---------- 1. График: потоки → разделы, работы с шифром = № ---------- */
      if (parts.gpr) {
        const { tasks } = await loadExisting();
        const groupId = new Map<string, string>();
        let order = tasks.filter((t) => !t.parent_id).reduce((m, t) => Math.max(m, t.sort_order ?? 0), 0);
        for (const stream of plan.gpr.streams) {
          const found = tasks.find((t) => !t.parent_id && !t.code && t.name.trim() === stream);
          if (found) {
            groupId.set(stream, found.id);
            continue;
          }
          order += 10;
          const { data, error } = await supabase
            .from("schedule_tasks")
            .insert({
              object_id: object.id, parent_id: null, sort_order: order, name: stream, code: null,
              start_plan: null, end_plan: null, start_fact: null, end_fact: null, tracking: "percent",
              volume_total: null, unit: null, cost_total: null, kind: "plan", progress_fact: 0,
              history: [note("Раздел (поток) создан")], created_at: now, updated_at: now,
            })
            .select()
            .single();
          if (error || !data) throw new Error(dbErrorText(error, `Не удалось создать раздел «${stream}»`));
          groupId.set(stream, (data as ScheduleTask).id);
        }
        const byId = new Map(tasks.map((t) => [t.id, t]));
        const inserts = [];
        for (const r of plan.gpr.rows) {
          const parentId = r.stream ? groupId.get(r.stream) || null : null;
          if (r.existingId) {
            const old = byId.get(r.existingId);
            const moved = (old?.parent_id || null) !== parentId;
            if (r.action === "same" && !moved) continue;
            const { error } = await supabase
              .from("schedule_tasks")
              .update({
                name: r.name, start_plan: r.startPlan, end_plan: r.endPlan, parent_id: parentId,
                ...(r.costTotal !== null ? { cost_total: r.costTotal } : {}),
                updated_at: now,
                history: [...(old?.history || []), note(r.changes.join("; ") || "Перенесена в раздел потока")],
              })
              .eq("id", r.existingId);
            if (error) throw new Error(dbErrorText(error, `Не удалось обновить работу № ${r.code}`));
          } else {
            inserts.push({
              object_id: object.id, parent_id: parentId, sort_order: Number(r.code) * 10, name: r.name, code: r.code,
              start_plan: r.startPlan, end_plan: r.endPlan, start_fact: null, end_fact: null, tracking: "percent",
              volume_total: null, unit: null, cost_total: r.costTotal, kind: "plan", progress_fact: 0,
              history: [note("Работа загружена из ГПР")], created_at: now, updated_at: now,
            });
          }
        }
        if (inserts.length) {
          const { error } = await supabase.from("schedule_tasks").insert(inserts);
          if (error) throw new Error(dbErrorText(error, "Не удалось создать работы графика"));
        }
        const c = count(plan.gpr.rows);
        done.push(`график: ${c.create} новых, ${c.update} обновлено`);
      }

      /* ---------- 2. Смета → статьи бюджета ---------- */
      if (parts.smeta) {
        const { budget } = await loadExisting();
        const byId = new Map(budget.map((b) => [b.id, b]));
        const inserts = [];
        for (const l of plan.smeta.lines) {
          if (l.action === "same") continue;
          if (l.existingId) {
            const old = byId.get(l.existingId);
            const { error } = await supabase
              .from("budget_lines")
              .update({ plan_amount: l.plan, updated_at: now, history: [...(old?.history || []), note(l.changes.join("; "))] })
              .eq("id", l.existingId);
            if (error) throw new Error(dbErrorText(error, `Не удалось обновить статью «${l.name}»`));
          } else {
            inserts.push({
              object_id: object.id, section: l.section, name: l.name, plan_amount: l.plan, fact_amount: 0,
              forecast_amount: null, note: l.note, history: [note("Статья загружена из сметы")], created_at: now, updated_at: now,
            });
          }
        }
        if (inserts.length) {
          const { error } = await supabase.from("budget_lines").insert(inserts);
          if (error) throw new Error(dbErrorText(error, "Не удалось создать статьи бюджета"));
        }
        const c = count(plan.smeta.lines);
        done.push(`смета: ${c.create} новых статей, ${c.update} обновлено`);
      }

      /* ---------- 3. ГПМ → заявки снабжения (после графика — нужны id работ) ---------- */
      if (parts.gpm) {
        const { tasks, supply } = await loadExisting();
        const taskIdByCode = new Map(tasks.filter((t) => t.code).map((t) => [t.code as string, t.id]));
        const byId = new Map(supply.map((s) => [s.id, s]));
        const inserts = [];
        for (const r of plan.gpm.rows) {
          if (r.action === "same" || r.action === "locked") continue;
          const taskId = r.workCode ? taskIdByCode.get(r.workCode) || null : null;
          if (r.existingId) {
            const old = byId.get(r.existingId);
            const { error } = await supabase
              .from("supply_requests")
              .update({ quantity: r.quantity, unit: r.unit, needed_by: r.neededBy, updated_at: now, history: [...(old?.history || []), note(r.changes.join("; "))] })
              .eq("id", r.existingId);
            if (error) throw new Error(dbErrorText(error, `Не удалось обновить заявку «${r.material}»`));
          } else {
            inserts.push({
              object_id: object.id, task_id: taskId, material_name: r.material, quantity: r.quantity, unit: r.unit,
              needed_by: r.neededBy, status: "draft", note: r.note, history: [note("Заявка создана из ГПМ")], created_at: now, updated_at: now,
            });
          }
        }
        if (inserts.length) {
          const { error } = await supabase.from("supply_requests").insert(inserts);
          if (error) throw new Error(dbErrorText(error, "Не удалось создать заявки снабжения"));
        }
        const c = count(plan.gpm.rows);
        done.push(`ГПМ: ${c.create} новых заявок, ${c.update} обновлено${c.locked ? `, ${c.locked} уже в работе — не тронуты` : ""}`);
      }
      setBusy(false);
      onDone(`Книга загружена в «${object.name}»: ${done.join("; ")}.`);
    } catch (e) {
      setBusy(false);
      setError(
        `${e instanceof Error ? e.message : "Ошибка загрузки"}${done.length ? `. Уже загружено — ${done.join("; ")}; повторная загрузка того же файла догрузит остальное без дублей.` : ""}`
      );
    }
  }

  const anyPart = plan && (parts.gpr || parts.smeta || parts.gpm);

  const block = (part: Part, title: string, found: boolean, errors: Issue[], children: React.ReactNode) => (
    <div className="wb-block">
      <label className="wb-check">
        <input
          type="checkbox"
          checked={parts[part]}
          disabled={!found || errors.length > 0}
          onChange={(e) => setParts({ ...parts, [part]: e.target.checked })}
        />
        <b>{title}</b>
        {!found && <span className="fin-muted"> — листа нет или он пуст</span>}
        {errors.length > 0 && <span className="is-neg"> — есть ошибки, не загрузится</span>}
      </label>
      {found && children}
      <IssueList title="Ошибки" items={errors} cls="imp-errors" />
    </div>
  );

  return (
    <div className="panel panel-wide panel-import show">
      <div className="panel-head">
        <h3>Книга объекта — {object.name}</h3>
        <button className="panel-close" aria-label="Закрыть" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="panel-body">
        <p className="hint" style={{ marginTop: 0 }}>
          Загрузите книгу по форме АТР-КО-01: ГПР уйдёт в «График работ» (потоки станут разделами), коммерческая
          смета — в «Сметы и бюджет», ГПМ — заявками в «Снабжение». Перед записью покажу, что создастся и что
          обновится; ничего не удаляется, факт затрат не трогается. Пустая форма — файл «АТР-КО-01 Книга объекта.xlsx»,
          лист «Как заполнять» в нём объясняет правила.
        </p>
        <div className="setup-actions">
          <button className="btn btn-primary" style={{ marginLeft: 0 }} onClick={() => fileRef.current?.click()} disabled={busy}>
            Выбрать файл
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.xls"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) readFile(f);
              e.target.value = "";
            }}
          />
        </div>
        {fileName && (
          <p className="hint">
            Файл: <b>{fileName}</b>
            {busy && " — читаю…"}
          </p>
        )}
        {error && <div className="banner show">{error}</div>}

        {plan && (
          <>
            {block("gpr", "График производства работ → «График работ»", plan.gpr.found, plan.gpr.errors, <>
              {(() => {
                const c = count(plan.gpr.rows);
                const priced = plan.gpr.rows.filter((r) => r.costTotal !== null).length;
                return (
                  <p className="hint">
                    {plan.gpr.rows.length} {plural(plan.gpr.rows.length, "работа", "работы", "работ")} в{" "}
                    {plan.gpr.streams.length} {plural(plan.gpr.streams.length, "потоке", "потоках", "потоках")}: новых {c.create}, обновится {c.update}, без изменений {c.same}.
                    {" "}Стоимость из сметы — у {priced} из {plan.gpr.rows.length}.
                  </p>
                );
              })()}
              <details>
                <summary>Работы</summary>
                <table className="wb-table">
                  <tbody>
                    {plan.gpr.rows.map((r) => (
                      <tr key={r.code}>
                        <td className="mono">{r.code}</td>
                        <td>
                          {r.name}
                          {r.stream && <span className="fin-muted"> · {r.stream}</span>}
                          {r.changes.length > 0 && <div className="fin-muted">{r.changes.join("; ")}</div>}
                        </td>
                        <td className="mono">{r.startPlan ? `${fmtDate(r.startPlan)}–${fmtDate(r.endPlan)}` : "—"}</td>
                        <td className="mono">{r.costTotal !== null ? fmtMoney(r.costTotal) : "—"}</td>
                        <td className="fin-muted">{ACTION_LABEL[r.action]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            </>)}

            {block("smeta", "Коммерческая смета → «Сметы и бюджет»", plan.smeta.found, plan.smeta.errors, <>
              {(() => {
                const c = count(plan.smeta.lines);
                const diff = plan.smeta.fileTotal !== null ? Math.round((plan.smeta.sum - plan.smeta.fileTotal) * 100) / 100 : null;
                return (
                  <p className="hint">
                    {plan.smeta.lines.length} {plural(plan.smeta.lines.length, "статья", "статьи", "статей")} на {fmtMoney(plan.smeta.sum)}
                    {plan.smeta.fileTotal !== null &&
                      (diff === 0 ? (
                        <> — совпадает с «Прямыми затратами» в файле</>
                      ) : (
                        <span className="is-neg"> — в файле прямые затраты {fmtMoney(plan.smeta.fileTotal)}, расхождение {fmtMoney(diff)}</span>
                      ))}
                    . Новых {c.create}, обновится план у {c.update}, без изменений {c.same}. Привязано к работам ГПР: {plan.smeta.linked} из{" "}
                    {plan.smeta.positions} позиций.
                  </p>
                );
              })()}
              <details>
                <summary>Статьи</summary>
                <table className="wb-table">
                  <tbody>
                    {plan.smeta.lines.map((l, i) => (
                      <tr key={i}>
                        <td>
                          {l.name}
                          {l.changes.length > 0 && <div className="fin-muted">{l.changes.join("; ")}</div>}
                        </td>
                        <td className="fin-muted">{BUDGET_SECTION_LABEL[l.section]}</td>
                        <td className="mono">{fmtMoney(l.plan)}</td>
                        <td className="fin-muted">{ACTION_LABEL[l.action]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            </>)}

            {block("gpm", "График поставки материалов → «Снабжение»", plan.gpm.found, plan.gpm.errors, <>
              {(() => {
                const c = count(plan.gpm.rows);
                const linked = plan.gpm.rows.filter((r) => r.workCode).length;
                return (
                  <p className="hint">
                    {plan.gpm.rows.length} {plural(plan.gpm.rows.length, "позиция", "позиции", "позиций")}: новых заявок {c.create}, обновится {c.update}, без изменений {c.same}
                    {c.locked ? `, уже в работе (не трогаем) ${c.locked}` : ""}. Привязано к работам: {linked} из {plan.gpm.rows.length}.
                  </p>
                );
              })()}
              <details>
                <summary>Заявки</summary>
                <table className="wb-table">
                  <tbody>
                    {plan.gpm.rows.map((r, i) => (
                      <tr key={i}>
                        <td>
                          {r.material}
                          {r.workName && <div className="fin-muted">{r.workName}</div>}
                        </td>
                        <td className="mono">
                          {r.quantity ?? "—"} {r.unit || ""}
                        </td>
                        <td className="mono">{fmtDate(r.neededBy)}</td>
                        <td className="fin-muted">{ACTION_LABEL[r.action]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            </>)}

            <IssueList title="Предупреждения — загрузке не мешают" items={plan.warnings} cls="imp-degraded" />
          </>
        )}
      </div>
      <div className="panel-foot">
        <button className="btn btn-ghost" onClick={onClose}>
          Закрыть
        </button>
        <button className="btn btn-primary" onClick={apply} disabled={!anyPart || busy}>
          {busy ? "Загружаю…" : "Загрузить отмеченное"}
        </button>
      </div>
    </div>
  );
}

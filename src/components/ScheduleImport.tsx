"use client";

import { useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { dbErrorText, needsSchemaSetup } from "@/lib/dbError";
import { detectMissingColumns, dropMissing } from "@/lib/dbColumns";
import { HistoryEntry, ScheduleTask } from "@/lib/types";
import {
  buildImportPlan,
  compareCodes,
  ImportPlan,
  ImportRow,
  TEMPLATE_HEADERS,
  trackingFor,
} from "@/lib/importSchedule";
import { fmtDate, fmtMoney, fmtNum, plural } from "@/lib/format";

interface Props {
  objectId: string;
  objectName: string;
  tasks: ScheduleTask[];
  onClose: () => void;
  /** schemaMissing — база отстала от приложения, нужна подготовка хранилища. */
  onDone: (message: string, schemaMissing?: boolean) => void;
}

/**
 * Сохранение книги под нужным именем. Встроенный writeFile отдаёт файл как
 * «download» без расширения, и человек потом не может его открыть.
 */
async function saveWorkbook(book: unknown, fileName: string) {
  const XLSX = await import("xlsx");
  const data = XLSX.write(book as never, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
  const blob = new Blob([data], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  // Отзываем ссылку не сразу: Safari успевает начать скачивание только после клика.
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Строки примера в шаблоне: показывают, как заполнять, и стираются перед загрузкой. */
const SAMPLE: (string | number)[][] = [
  ["1", "Нулевой цикл", "", "", "", "", "", "", "", ""],
  ["1.1", "Свайное поле силосного корпуса", "20.07.2026", "24.08.2026", 320, "шт", 9600000, "", "", ""],
  ["1.2", "Бетонирование ростверка", "25.08.2026", "20.09.2026", 300, "м³", 4500000, "", "", ""],
  ["2", "Монтаж силосного корпуса", "", "", "", "", "", "", "", ""],
  ["2.1", "Сборка силосов №1–4", "18.09.2026", "02.11.2026", 4, "шт", 74000000, "", "", ""],
];

/** Поля этапа, появившиеся после первых версий: отставшая база их может не знать. */
const OPTIONAL_COLUMNS = ["code", "tracking", "kind", "reason", "volume_total", "unit", "cost_total"];

export default function ScheduleImport({ objectId, objectName, tasks, onClose, onDone }: Props) {
  const [missingColumns, setMissingColumns] = useState<Set<string>>(new Set());
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removeMissing, setRemoveMissing] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const ready = plan && plan.errors.length === 0 && plan.rows.length > 0;

  const visibleRows = useMemo(() => {
    if (!plan) return [];
    return plan.rows.slice().sort((a, b) => compareCodes(a.code, b.code));
  }, [plan]);

  /** Шаблон с заголовками, примером и уже выставленными форматами дат. */
  async function downloadTemplate() {
    const XLSX = await import("xlsx");
    const rows = [
      [`График производства работ — ${objectName}`],
      ["Шифр задаёт иерархию: 1 — раздел, 1.1 и 1.2 — работы внутри него. Строки примера удалите."],
      [],
      TEMPLATE_HEADERS,
      ...SAMPLE,
    ];
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    sheet["!cols"] = [
      { wch: 8 }, { wch: 46 }, { wch: 13 }, { wch: 14 },
      { wch: 10 }, { wch: 9 }, { wch: 14 }, { wch: 13 }, { wch: 14 }, { wch: 9 },
    ];
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, "ГПР");
    // Имя латиницей: часть браузеров теряет кириллицу в download-ссылке,
    // и файл сохраняется как «download» без расширения.
    await saveWorkbook(book, "GPR-shablon.xlsx");
  }

  /** Выгрузка текущего графика в том же формате: правьте в Excel и загружайте обратно. */
  async function exportCurrent() {
    const XLSX = await import("xlsx");
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const codeOf = (t: ScheduleTask): string => {
      if (t.code) return t.code;
      // У этапов, заведённых руками, шифра нет — строим его по месту в дереве.
      const chain: number[] = [];
      let cur: ScheduleTask | undefined = t;
      while (cur) {
        const siblings = tasks
          .filter((x) => (x.parent_id || null) === (cur!.parent_id || null))
          .sort((a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at));
        chain.unshift(siblings.findIndex((x) => x.id === cur!.id) + 1);
        cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
      }
      return chain.join(".");
    };
    const rows = tasks
      .map((t) => ({ t, code: codeOf(t) }))
      .sort((a, b) => compareCodes(a.code, b.code))
      .map(({ t, code }) => [
        code,
        t.name,
        t.start_plan ? fmtDate(t.start_plan) : "",
        t.end_plan ? fmtDate(t.end_plan) : "",
        t.volume_total ?? "",
        t.unit ?? "",
        t.cost_total ?? "",
        t.start_fact ? fmtDate(t.start_fact) : "",
        t.end_fact ? fmtDate(t.end_fact) : "",
        t.progress_fact ?? "",
      ]);
    const sheet = XLSX.utils.aoa_to_sheet([TEMPLATE_HEADERS, ...rows]);
    sheet["!cols"] = [
      { wch: 8 }, { wch: 46 }, { wch: 13 }, { wch: 14 },
      { wch: 10 }, { wch: 9 }, { wch: 13 }, { wch: 14 }, { wch: 9 },
    ];
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, "ГПР");
    await saveWorkbook(book, `GPR-${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  async function readFile(file: File) {
    setError(null);
    setPlan(null);
    setFileName(file.name);
    setBusy(true);
    try {
      const XLSX = await import("xlsx");
      const buffer = await file.arrayBuffer();
      // cellDates — чтобы даты приходили объектами Date, а не номерами дней.
      const book = XLSX.read(buffer, { cellDates: true, codepage: 1251 });
      const first = book.SheetNames[0];
      if (!first) {
        setError("В файле нет ни одного листа.");
        setBusy(false);
        return;
      }
      const matrix = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets[first], {
        header: 1,
        raw: true,
        defval: null,
      });
      // Спрашиваем базу, какие поля она знает: со старой схемой сопоставляем по названию.
      const missing = await detectMissingColumns("schedule_tasks", OPTIONAL_COLUMNS);
      setMissingColumns(missing);
      setPlan(buildImportPlan({ matrix, existing: tasks, matchByName: missing.has("code") }));
    } catch (e) {
      setError("Не удалось прочитать файл: " + (e instanceof Error ? e.message : String(e)));
    }
    setBusy(false);
  }

  /** Записывает разобранный план: сначала разделы, потом работы внутри них. */
  async function apply() {
    if (!plan || !ready) return;
    setBusy(true);
    const now = new Date().toISOString();
    const codeToId = new Map<string, string>();
    tasks.forEach((t) => {
      if (t.code) codeToId.set(t.code, t.id);
    });

    const byDepth = new Map<number, ImportRow[]>();
    visibleRows.forEach((r) => {
      const depth = r.code.split(".").length;
      const list = byDepth.get(depth);
      if (list) list.push(r);
      else byDepth.set(depth, [r]);
    });

    let createdCount = 0;
    let updatedCount = 0;
    for (const depth of Array.from(byDepth.keys()).sort((a, b) => a - b)) {
      const rows = byDepth.get(depth) as ImportRow[];

      const toCreate = rows.filter((r) => r.action === "create");
      if (toCreate.length) {
        const payload = toCreate.map((r, i) => ({
          object_id: objectId,
          parent_id: r.parentCode ? codeToId.get(r.parentCode) ?? null : null,
          sort_order: (i + 1) * 10,
          code: r.code,
          name: r.name,
          start_plan: r.startPlan,
          end_plan: r.endPlan,
          start_fact: r.startFact,
          end_fact: r.endFact,
          tracking: trackingFor(r.volumeTotal),
          kind: "plan",
          reason: null,
          volume_total: r.volumeTotal,
          unit: r.unit,
          cost_total: r.costTotal,
          progress_fact: r.progressFact ?? 0,
          history: [{ at: now, text: `Загружено из ГПР (${fileName})` }],
          created_at: now,
          updated_at: now,
        }));
        const { data, error: insertError } = await supabase
          .from("schedule_tasks")
          .insert(payload.map((row) => dropMissing(row, missingColumns)))
          .select();
        if (insertError) {
          onDone(dbErrorText(insertError, "Загрузка прервана"), needsSchemaSetup(insertError));
          setBusy(false);
          return;
        }
        const created = data as ScheduleTask[];
        created.forEach((t, i) => {
          // Без поля шифра в базе связываем по порядку вставки: он сохранён.
          const code = t.code || toCreate[i]?.code;
          if (code) codeToId.set(code, t.id);
        });
        createdCount += toCreate.length;
      }

      for (const r of rows.filter((x) => x.action === "update")) {
        const old = tasks.find((t) => t.id === r.existingId);
        const patch: Record<string, unknown> = { name: r.name, updated_at: now };
        // Пустая клетка означает «не трогать», поэтому подставляем только заполненное.
        if (r.startPlan) patch.start_plan = r.startPlan;
        if (r.endPlan) patch.end_plan = r.endPlan;
        if (r.startFact) patch.start_fact = r.startFact;
        if (r.endFact) patch.end_fact = r.endFact;
        if (r.volumeTotal !== null) {
          patch.volume_total = r.volumeTotal;
          patch.tracking = trackingFor(r.volumeTotal);
        }
        if (r.unit) patch.unit = r.unit;
        if (r.costTotal !== null) patch.cost_total = r.costTotal;
        if (r.progressFact !== null) patch.progress_fact = r.progressFact;
        if (r.parentCode) patch.parent_id = codeToId.get(r.parentCode) ?? null;

        const history: HistoryEntry[] = [
          ...(old?.history || []),
          { at: now, text: `Обновлено загрузкой ГПР: ${r.changes.join("; ")}` },
        ];
        const { error: updateError } = await supabase
          .from("schedule_tasks")
          .update(dropMissing({ ...patch, history }, missingColumns))
          .eq("id", r.existingId as string);
        if (updateError) {
          onDone(dbErrorText(updateError, "Загрузка прервана"), needsSchemaSetup(updateError));
          setBusy(false);
          return;
        }
        updatedCount++;
      }
    }

    let removed = 0;
    if (removeMissing && plan.missing.length) {
      const ids = plan.missing.map((t) => t.id);
      const { error: deleteError } = await supabase.from("schedule_tasks").delete().in("id", ids);
      if (deleteError) {
        onDone(dbErrorText(deleteError, "Этапы загружены, но лишние не удалились"), needsSchemaSetup(deleteError));
        setBusy(false);
        return;
      }
      removed = ids.length;
    }

    setBusy(false);
    onDone(
      `Загружено из ГПР: ${createdCount} ${plural(createdCount, "новый этап", "новых этапа", "новых этапов")}` +
        (updatedCount ? `, обновлено ${updatedCount}` : "") +
        (removed ? `, удалено ${removed}` : "") +
        "."
    );
  }

  return (
    <div className="panel panel-wide panel-import show">
      <div className="panel-head">
        <h3>Загрузка ГПР</h3>
        <button className="panel-close" aria-label="Закрыть" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="panel-body">
        <p className="hint" style={{ marginTop: 0 }}>
          Перенесите свой график производства работ в шаблон и загрузите файл — этапы
          создадутся сами. Иерархию задаёт шифр: <b>1</b> — раздел, <b>1.1</b> и <b>1.2</b> —
          работы внутри него. Принимаются .xlsx и .csv. Файлы сохраняются под именами
          GPR-shablon.xlsx и GPR-дата.xlsx — латиницей, чтобы не терялись расширения.
        </p>

        <div className="setup-actions">
          <button className="btn btn-ghost" onClick={downloadTemplate} disabled={busy}>
            Скачать шаблон
          </button>
          {tasks.length > 0 && (
            <button className="btn btn-ghost" onClick={exportCurrent} disabled={busy}>
              Выгрузить текущий график
            </button>
          )}
          <button
            className="btn btn-primary"
            style={{ marginLeft: 0 }}
            onClick={() => fileRef.current?.click()}
            disabled={busy}
          >
            Выбрать файл
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.xls,.csv"
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
          </p>
        )}
        {missingColumns.size > 0 && (
          <div className="imp-degraded">
            <b>База отстала от приложения</b> — нет{" "}
            {Array.from(missingColumns).map((c) => `«${c}»`).join(", ")}. Загрузка пройдёт, но
            {missingColumns.has("code") ? " этапы будут сопоставляться по наименованию, а не по шифру," : ""}
            {missingColumns.size > (missingColumns.has("code") ? 1 : 0)
              ? " часть данных из файла не сохранится."
              : " шифры не сохранятся."}{" "}
            Чтобы работало полностью, подготовьте хранилище заново — инструкция появится после
            закрытия этого окна.
          </div>
        )}
        {error && <div className="banner show">{error}</div>}

        {plan && (
          <>
            <div className="imp-summary">
              <span className="chip st-good">
                <span className="n">{plan.created}</span> создать
              </span>
              <span className="chip st-warn">
                <span className="n">{plan.updated}</span> обновить
              </span>
              <span className="chip st-neutral">
                <span className="n">{plan.same}</span> без изменений
              </span>
              {plan.errors.length > 0 && (
                <span className="chip st-bad">
                  <span className="n">{plan.errors.length}</span>{" "}
                  {plural(plan.errors.length, "ошибка", "ошибки", "ошибок")}
                </span>
              )}
            </div>

            {plan.errors.length > 0 && (
              <div className="imp-errors">
                <h4>Файл не будет загружен, пока есть ошибки</h4>
                <ul>
                  {plan.errors.slice(0, 40).map((e, i) => (
                    <li key={i}>
                      <b>строка {e.line}</b> — {e.text}
                    </li>
                  ))}
                </ul>
                {plan.errors.length > 40 && (
                  <p className="hint">…и ещё {plan.errors.length - 40}. Исправьте эти и загрузите снова.</p>
                )}
              </div>
            )}

            {plan.rows.length > 0 && (
              <div className="imp-rows">
                {visibleRows.slice(0, 200).map((r) => (
                  <div className={`imp-row is-${r.action}`} key={r.code}>
                    <span className="imp-code mono">{r.code}</span>
                    <span className="imp-name">{r.name}</span>
                    <span className="imp-dates mono">
                      {r.startPlan || r.endPlan
                        ? `${fmtDate(r.startPlan)}–${fmtDate(r.endPlan)}`
                        : "по подэтапам"}
                    </span>
                    <span className="imp-vol mono">
                      {r.volumeTotal !== null ? `${fmtNum(r.volumeTotal, 3)} ${r.unit || ""}`.trim() : ""}
                    </span>
                    <span className="imp-cost mono">
                      {r.costTotal !== null ? fmtMoney(r.costTotal) : ""}
                    </span>
                    <span className={`imp-act imp-act-${r.action}`}>
                      {r.action === "create" ? "новый" : r.action === "update" ? "изменить" : "без изменений"}
                    </span>
                  </div>
                ))}
                {visibleRows.length > 200 && (
                  <p className="hint">Показаны первые 200 строк из {visibleRows.length}.</p>
                )}
              </div>
            )}

            {plan.missing.length > 0 && (
              <div className="imp-missing">
                <p>
                  В графике есть {plan.missing.length}{" "}
                  {plural(plan.missing.length, "этап", "этапа", "этапов")}, которых нет в файле. По
                  умолчанию они остаются нетронутыми.
                </p>
                <label className="cat-check">
                  <input
                    type="checkbox"
                    checked={removeMissing}
                    onChange={(e) => setRemoveMissing(e.target.checked)}
                  />
                  <span>Удалить их вместе с накопленным фактом</span>
                </label>
              </div>
            )}
          </>
        )}
      </div>
      <div className="panel-foot">
        <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
          Отмена
        </button>
        <button className="btn btn-primary" onClick={apply} disabled={!ready || busy}>
          {busy ? "Загрузка…" : "Загрузить в график"}
        </button>
      </div>
    </div>
  );
}

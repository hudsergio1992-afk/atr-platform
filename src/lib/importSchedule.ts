import { ScheduleTask, TrackingMode } from "@/lib/types";

/**
 * Разбор графика производства работ из таблицы.
 *
 * Иерархия задаётся шифром: «1» — раздел, «1.1» и «1.2» — работы внутри него,
 * «1.1.1» — ещё уровень. Так нумеруют в ППР и сметах, поэтому переносить ГПР
 * в шаблон можно почти как есть.
 */

export type ImportAction = "create" | "update" | "same";

export interface ImportRow {
  /** Номер строки в файле — чтобы человек нашёл её глазами. */
  line: number;
  code: string;
  name: string;
  startPlan: string | null;
  endPlan: string | null;
  startFact: string | null;
  endFact: string | null;
  volumeTotal: number | null;
  unit: string | null;
  /** Стоимость этапа, ₽. */
  costTotal: number | null;
  progressFact: number | null;
  /** Шифр родителя, выведенный из кода. */
  parentCode: string | null;
  action: ImportAction;
  /** Что именно изменится, если строка обновляет существующий этап. */
  changes: string[];
  /** id существующего этапа с таким шифром. */
  existingId: string | null;
}

export interface ImportIssue {
  line: number;
  text: string;
}

export interface ImportPlan {
  rows: ImportRow[];
  errors: ImportIssue[];
  /** Этапы объекта, которых в файле нет: по умолчанию остаются нетронутыми. */
  missing: ScheduleTask[];
  created: number;
  updated: number;
  same: number;
}

/** Ожидаемые колонки шаблона и слова, по которым они узнаются в чужом файле. */
const COLUMNS: { key: keyof ImportRow | "skip"; title: string; match: string[] }[] = [
  { key: "code", title: "Шифр", match: ["шифр", "код", "№ п/п", "номер", "n п/п"] },
  { key: "name", title: "Наименование работы", match: ["наименование", "работа", "этап", "название"] },
  { key: "startPlan", title: "Начало план", match: ["начало план", "нач. план", "дата начала", "начало"] },
  { key: "endPlan", title: "Окончание план", match: ["окончание план", "оконч. план", "дата окончания", "окончание"] },
  { key: "volumeTotal", title: "Объём", match: ["объём", "объем", "кол-во", "количество"] },
  { key: "unit", title: "Ед. изм.", match: ["ед. изм", "ед.изм", "единица", "ед"] },
  { key: "costTotal", title: "Стоимость, ₽", match: ["стоимость", "сумма", "цена", "смета"] },
  { key: "startFact", title: "Начало факт", match: ["начало факт", "нач. факт"] },
  { key: "endFact", title: "Окончание факт", match: ["окончание факт", "оконч. факт"] },
  { key: "progressFact", title: "% факт", match: ["% факт", "процент", "готовность", "выполнение"] },
];

export const TEMPLATE_HEADERS = COLUMNS.map((c) => c.title);

function norm(v: unknown): string {
  return String(v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Сопоставляет колонки файла с ожидаемыми. Ищет наиболее длинное совпадение,
 * чтобы «Начало факт» не улетело в «Начало».
 */
export function mapHeaders(header: unknown[]): Record<string, number> {
  const map: Record<string, number> = {};
  header.forEach((cell, index) => {
    const text = norm(cell);
    if (!text) return;
    let best: { key: string; len: number } | null = null;
    for (const col of COLUMNS) {
      if (col.key === "skip") continue;
      for (const m of col.match) {
        if (text.includes(m) && (!best || m.length > best.len)) {
          best = { key: col.key as string, len: m.length };
        }
      }
    }
    if (best && map[best.key] === undefined) map[best.key] = index;
  });
  return map;
}

/** Дата из ячейки: Date, «01.03.2026», «2026-03-01» или номер дня Excel. */
export function parseCellDate(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${value.getFullYear()}-${p(value.getMonth() + 1)}-${p(value.getDate())}`;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    // Счёт дней в Excel идёт с 30.12.1899 из-за несуществующего 29.02.1900.
    const ms = Math.round((value - 25569) * 86400000);
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return null;
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  }
  const text = String(value).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})$/.exec(text);
  if (m) {
    const year = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${year}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  return null;
}

/** Число из ячейки: принимает «1 200,5», «1200.5», пробелы-разделители. */
export function parseCellNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value).replace(/\s| /g, "").replace(",", ".");
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/** Шифр родителя: «1.2.3» -> «1.2», «1» -> null. */
export function parentOfCode(code: string): string | null {
  const parts = code.split(".").filter(Boolean);
  if (parts.length <= 1) return null;
  return parts.slice(0, -1).join(".");
}

function fmt(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  return String(v);
}

/** Способ выдачи в задании: объём задан — выдаём объёмом. */
export function trackingFor(volume: number | null): TrackingMode {
  return volume !== null && volume > 0 ? "volume" : "percent";
}

export interface BuildPlanInput {
  /** Строки файла как массив массивов; первая — заголовок. */
  matrix: unknown[][];
  /** Этапы объекта, уже заведённые в системе. */
  existing: ScheduleTask[];
  /**
   * База не знает поля шифра (схему не обновляли) — тогда существующие этапы
   * ищутся по наименованию. Менее строго, но позволяет работать без похода в БД.
   */
  matchByName?: boolean;
}

export function buildImportPlan({ matrix, existing, matchByName }: BuildPlanInput): ImportPlan {
  const errors: ImportIssue[] = [];
  const rows: ImportRow[] = [];

  if (!matrix.length) {
    return { rows, errors: [{ line: 0, text: "Файл пустой." }], missing: [], created: 0, updated: 0, same: 0 };
  }

  // Заголовок может стоять не в первой строке: ищем ту, где узнаются шифр и наименование.
  let headerIndex = -1;
  let headers: Record<string, number> = {};
  for (let i = 0; i < Math.min(matrix.length, 15); i++) {
    const candidate = mapHeaders(matrix[i]);
    if (candidate.code !== undefined && candidate.name !== undefined) {
      headerIndex = i;
      headers = candidate;
      break;
    }
  }
  if (headerIndex === -1) {
    return {
      rows,
      errors: [{ line: 0, text: "Не нашлись колонки «Шифр» и «Наименование работы». Возьмите шаблон и перенесите данные в него." }],
      missing: [],
      created: 0,
      updated: 0,
      same: 0,
    };
  }

  const norma = (v: string) => v.trim().toLowerCase().replace(/\s+/g, " ").replace(/[«»"']/g, "");
  const byCode = new Map<string, ScheduleTask>();
  const byName = new Map<string, ScheduleTask>();
  existing.forEach((t) => {
    if (t.code) byCode.set(t.code.trim(), t);
    if (t.name) byName.set(norma(t.name), t);
  });
  const findExisting = (code: string, name: string): ScheduleTask | null =>
    (matchByName ? byName.get(norma(name)) : byCode.get(code)) || null;

  const seen = new Set<string>();
  const cell = (row: unknown[], key: string) =>
    headers[key] === undefined ? null : row[headers[key]] ?? null;

  for (let i = headerIndex + 1; i < matrix.length; i++) {
    const raw = matrix[i];
    if (!raw || raw.every((c) => c === null || c === undefined || String(c).trim() === "")) continue;
    const line = i + 1;

    const code = String(cell(raw, "code") ?? "").trim().replace(/\.+$/, "");
    const name = String(cell(raw, "name") ?? "").trim();
    if (!code && !name) continue;
    if (!code) {
      errors.push({ line, text: `«${name || "без названия"}» — не заполнен шифр.` });
      continue;
    }
    if (!name) {
      errors.push({ line, text: `Шифр ${code} — не заполнено наименование работы.` });
      continue;
    }
    if (!/^\d+(\.\d+)*$/.test(code)) {
      errors.push({ line, text: `Шифр «${code}» непонятен. Нужен вид 1, 1.1, 1.1.2.` });
      continue;
    }
    if (seen.has(code)) {
      errors.push({ line, text: `Шифр ${code} встречается в файле дважды.` });
      continue;
    }
    seen.add(code);

    const startPlan = parseCellDate(cell(raw, "startPlan"));
    const endPlan = parseCellDate(cell(raw, "endPlan"));
    const startFact = parseCellDate(cell(raw, "startFact"));
    const endFact = parseCellDate(cell(raw, "endFact"));
    const rawStartPlan = cell(raw, "startPlan");
    const rawEndPlan = cell(raw, "endPlan");
    if (rawStartPlan && startPlan === null) {
      errors.push({ line, text: `Шифр ${code} — не разобрана дата начала «${String(rawStartPlan)}».` });
      continue;
    }
    if (rawEndPlan && endPlan === null) {
      errors.push({ line, text: `Шифр ${code} — не разобрана дата окончания «${String(rawEndPlan)}».` });
      continue;
    }
    if (startPlan && endPlan && endPlan < startPlan) {
      errors.push({ line, text: `Шифр ${code} — окончание ${endPlan} раньше начала ${startPlan}.` });
      continue;
    }
    if (startFact && endFact && endFact < startFact) {
      errors.push({ line, text: `Шифр ${code} — фактическое окончание раньше фактического начала.` });
      continue;
    }

    const volumeTotal = parseCellNumber(cell(raw, "volumeTotal"));
    if (volumeTotal !== null && volumeTotal < 0) {
      errors.push({ line, text: `Шифр ${code} — отрицательный объём.` });
      continue;
    }
    const unitRaw = cell(raw, "unit");
    const unit = unitRaw === null ? null : String(unitRaw).trim() || null;
    if (volumeTotal !== null && volumeTotal > 0 && !unit) {
      errors.push({ line, text: `Шифр ${code} — указан объём, но нет единицы измерения.` });
      continue;
    }

    const costTotal = parseCellNumber(cell(raw, "costTotal"));
    if (costTotal !== null && costTotal < 0) {
      errors.push({ line, text: `Шифр ${code} — отрицательная стоимость.` });
      continue;
    }

    let progressFact = parseCellNumber(cell(raw, "progressFact"));
    if (progressFact !== null) {
      // «0,85» в колонке процентов почти наверняка означает 85%.
      if (progressFact > 0 && progressFact <= 1 && String(cell(raw, "progressFact")).includes(".")) {
        progressFact = progressFact * 100;
      }
      if (progressFact < 0 || progressFact > 100) {
        errors.push({ line, text: `Шифр ${code} — процент готовности ${progressFact} вне 0…100.` });
        continue;
      }
    }

    const parentCode = parentOfCode(code);
    const existingTask = findExisting(code, name);

    const changes: string[] = [];
    if (existingTask) {
      const cmp: [string, unknown, unknown][] = [
        ["наименование", existingTask.name, name],
        ["начало план", existingTask.start_plan, startPlan],
        ["окончание план", existingTask.end_plan, endPlan],
        ["начало факт", existingTask.start_fact, startFact],
        ["окончание факт", existingTask.end_fact, endFact],
        ["объём", existingTask.volume_total === null ? null : Number(existingTask.volume_total), volumeTotal],
        ["ед. изм.", existingTask.unit, unit],
        ["стоимость", existingTask.cost_total === null ? null : Number(existingTask.cost_total), costTotal],
        [
          "% факт",
          existingTask.progress_fact === null ? null : Number(existingTask.progress_fact),
          progressFact,
        ],
      ];
      cmp.forEach(([label, was, now]) => {
        // Пустая клетка означает «не трогать», а не «стереть».
        if (now === null || now === undefined || now === "") return;
        if (String(was ?? "") !== String(now)) changes.push(`${label}: ${fmt(was)} → ${fmt(now)}`);
      });
    }

    rows.push({
      line,
      code,
      name,
      startPlan,
      endPlan,
      startFact,
      endFact,
      volumeTotal,
      unit,
      costTotal,
      progressFact,
      parentCode,
      existingId: existingTask ? existingTask.id : null,
      action: existingTask ? (changes.length ? "update" : "same") : "create",
      changes,
    });
  }

  // Родитель должен существовать — в файле или уже в системе.
  const codesInFile = new Set(rows.map((r) => r.code));
  rows.forEach((r) => {
    if (r.parentCode && !codesInFile.has(r.parentCode) && !byCode.has(r.parentCode) && !matchByName) {
      errors.push({
        line: r.line,
        text: `Шифр ${r.code} — нет родительской строки ${r.parentCode}. Добавьте её в файл.`,
      });
    }
  });

  const namesInFile = new Set(rows.map((r) => norma(r.name)));
  const missing = matchByName
    ? existing.filter((t) => !namesInFile.has(norma(t.name)))
    : existing.filter((t) => t.code && !codesInFile.has(t.code.trim()));

  return {
    rows,
    errors,
    missing,
    created: rows.filter((r) => r.action === "create").length,
    updated: rows.filter((r) => r.action === "update").length,
    same: rows.filter((r) => r.action === "same").length,
  };
}

/** Сортировка по шифру: 1, 1.1, 1.2, 1.10, 2 — а не по алфавиту. */
export function compareCodes(a: string, b: string): number {
  const pa = a.split(".").map((x) => Number(x) || 0);
  const pb = b.split(".").map((x) => Number(x) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? -1) - (pb[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
}

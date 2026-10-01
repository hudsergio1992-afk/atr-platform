import { supabase } from "@/lib/supabaseClient";
import { PHOTO_BUCKET } from "@/lib/types";

/**
 * Полная выгрузка данных сайта в Excel — резервная копия «на всякий случай».
 * Все таблицы базы с id и историей (сложные поля — JSON-текстом) плюс список
 * файлов фото. Формат тот же, что у листа «Копия сайта» резервной копии:
 * по нему Claude может загрузить данные обратно с теми же id.
 * SheetJS подгружается с cdnjs только при нажатии кнопки — в сборку сайта не входит.
 */

export const EXPORT_TABLES = [
  "objects",
  "schedule_tasks",
  "stage_catalog",
  "weekly_assignments",
  "weekly_items",
  "acceptance_acts",
  "work_log_entries",
  "material_certificates",
  "suppliers",
  "supply_requests",
  "supply_offers",
  "budget_lines",
  "customer_payments",
  "photo_reports",
  "site_issues",
] as const;

const SHEETJS_URL = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";

type Row = Record<string, unknown>;
type Cell = string | number | boolean | null;

interface SheetJs {
  utils: {
    aoa_to_sheet: (rows: Cell[][]) => Record<string, unknown>;
    book_new: () => unknown;
    book_append_sheet: (wb: unknown, ws: unknown, name: string) => void;
  };
  writeFile: (wb: unknown, name: string) => void;
}

function loadSheetJs(): Promise<SheetJs> {
  const w = window as unknown as { XLSX?: SheetJs };
  if (w.XLSX) return Promise.resolve(w.XLSX);
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SHEETJS_URL;
    s.onload = () => (w.XLSX ? resolve(w.XLSX) : reject(new Error("Excel-библиотека не загрузилась")));
    s.onerror = () => reject(new Error("Нет связи с cdnjs — Excel-библиотека не загрузилась"));
    document.head.appendChild(s);
  });
}

async function fetchTable(table: string): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from(table)
      .select("*")
      .order("created_at", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`Таблица ${table}: ${error.message}`);
    out.push(...((data as Row[]) || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function listPhotos(prefix = "", depth = 0): Promise<{ path: string; size: number | null }[]> {
  const { data, error } = await supabase.storage.from(PHOTO_BUCKET).list(prefix, { limit: 1000 });
  if (error || !data) return [];
  const out: { path: string; size: number | null }[] = [];
  for (const f of data) {
    const full = prefix ? `${prefix}/${f.name}` : f.name;
    if (f.id) out.push({ path: full, size: (f.metadata as { size?: number } | null)?.size ?? null });
    else if (depth < 4) out.push(...(await listPhotos(full, depth + 1)));
  }
  return out;
}

const cell = (v: unknown): Cell => {
  if (v === null || v === undefined) return null;
  if (typeof v === "object") return JSON.stringify(v);
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  return String(v);
};

/** Выгружает всё в файл «АТР_копия_сайта_ГГГГ-ММ-ДД.xlsx». Возвращает число записей. */
export async function exportAllToExcel(): Promise<number> {
  const XLSX = await loadSheetJs();
  const dump: Record<string, Row[]> = {};
  for (const t of EXPORT_TABLES) dump[t] = await fetchTable(t);
  const files = await listPhotos();

  const now = new Date();
  const rows: Cell[][] = [
    [`Копия данных сайта Стройплатформа АТР — выгрузка ${now.toLocaleString("ru-RU")}`],
    ["Поля history и другие сложные поля записаны как JSON-текст. Для восстановления не редактировать."],
    [],
    ["Таблица", "Записей"],
    ...EXPORT_TABLES.map((t): Cell[] => [t, dump[t].length]),
    ["site-photos (файлы хранилища)", files.length],
    [],
  ];
  for (const t of EXPORT_TABLES) {
    const list = dump[t];
    rows.push([`=== ТАБЛИЦА: ${t} (${list.length} записей) ===`]);
    if (!list.length) {
      rows.push(["(пусто)"], []);
      continue;
    }
    const cols = [...new Set(list.flatMap((r) => Object.keys(r)))];
    rows.push(cols);
    list.forEach((r) => rows.push(cols.map((c) => cell(r[c]))));
    rows.push([]);
  }
  rows.push([`=== ХРАНИЛИЩЕ: ${PHOTO_BUCKET} (${files.length} файлов) ===`], ["path", "size_bytes"]);
  files.forEach((f) => rows.push([f.path, f.size]));

  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws["!cols"] = Array.from({ length: 25 }, () => ({ wch: 18 }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Копия сайта");
  XLSX.writeFile(wb, `АТР_копия_сайта_${now.toISOString().slice(0, 10)}.xlsx`);
  return EXPORT_TABLES.reduce((s, t) => s + dump[t].length, 0);
}

/**
 * Короткий скрипт подготовки: только то, чего в базе не хватает.
 *
 * Полная схема — девять тысяч символов, и владелец базы каждый раз вставляет
 * её целиком. Здесь из того же файла отбираются нужные предложения: база
 * опрашивается через PostgREST, и в скрипт попадает лишь недостающее.
 * Все предложения схемы идемпотентны, поэтому лишнее в отборе безвредно.
 */

import { supabase } from "@/lib/supabaseClient";

/** Чего база не знает. */
export interface SchemaGap {
  /** Таблицы, которых нет вовсе. */
  tables: string[];
  /** Колонки, которых нет в существующих таблицах. */
  columns: { table: string; column: string }[];
}

export function gapIsEmpty(gap: SchemaGap): boolean {
  return gap.tables.length === 0 && gap.columns.length === 0;
}

/**
 * Поля, появившиеся после первых версий. Колонки, которые были с самого
 * начала, не проверяются: без них таблица не создалась бы вовсе.
 */
export const EXPECTED: { table: string; columns: string[] }[] = [
  { table: "objects", columns: [] },
  {
    table: "schedule_tasks",
    columns: ["code", "tracking", "kind", "reason", "volume_total", "unit", "cost_total"],
  },
  { table: "weekly_assignments", columns: [] },
  { table: "weekly_items", columns: ["crew", "note"] },
  { table: "stage_catalog", columns: [] },
];

function saysNoTable(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  const code = error.code || "";
  const msg = error.message || "";
  return (
    code === "42P01" ||
    code === "PGRST205" ||
    /relation .* does not exist/i.test(msg) ||
    /could not find the table/i.test(msg)
  );
}

function saysNoColumn(
  error: { code?: string; message?: string; details?: string | null } | null,
  column: string
): boolean {
  if (!error) return false;
  const code = error.code || "";
  const msg = error.message || "";
  const aboutIt = msg.includes(column) || (error.details || "").includes(column);
  return (
    aboutIt &&
    (code === "42703" || code === "PGRST204" || /does not exist|could not find/i.test(msg))
  );
}

/** Опрашивает базу: какие таблицы и колонки она знает, а какие нет. */
export async function detectSchemaGap(): Promise<SchemaGap> {
  const tables: string[] = [];
  const columns: { table: string; column: string }[] = [];

  await Promise.all(
    EXPECTED.map(async ({ table, columns: expected }) => {
      const { error } = await supabase.from(table).select("id").limit(1);
      if (saysNoTable(error)) {
        tables.push(table);
        return;
      }
      // Таблица отвечает иначе (нет прав, нет связи) — о колонках судить нельзя.
      if (error) return;
      await Promise.all(
        expected.map(async (column) => {
          const res = await supabase.from(table).select(column).limit(1);
          if (saysNoColumn(res.error, column)) columns.push({ table, column });
        })
      );
    })
  );

  tables.sort();
  columns.sort((a, b) => a.table.localeCompare(b.table) || a.column.localeCompare(b.column));
  return { tables, columns };
}

/**
 * Режет схему на отдельные предложения. Точка с запятой внутри тела $$…$$
 * не считается концом: там живут блоки do с проверками ограничений.
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = "";
  let inDollar = false;
  let inLineComment = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const pair = sql.slice(i, i + 2);
    if (inLineComment) {
      buf += ch;
      if (ch === "\n") inLineComment = false;
      continue;
    }
    if (!inDollar && pair === "--") {
      inLineComment = true;
      buf += ch;
      continue;
    }
    if (pair === "$$") {
      inDollar = !inDollar;
      buf += pair;
      i++;
      continue;
    }
    if (ch === ";" && !inDollar) {
      buf += ch;
      const trimmed = buf.trim();
      if (trimmed) out.push(trimmed);
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

/** Код предложения без комментариев — по нему и решаем, нужно ли оно. */
function body(statement: string): string {
  return statement
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

function mentionsWord(text: string, word: string): boolean {
  // Границей считается любой не-словесный знак, включая точку: имена таблиц
  // в схеме пишутся как public.schedule_tasks.
  return new RegExp(`(^|[^\\w])${word}(\\b|$)`).test(text);
}

/**
 * Собирает короткий скрипт из полной схемы.
 *
 * Берётся всё, что касается недостающих таблиц, и всё, что упоминает
 * недостающие колонки. Создание таблицы, которая уже есть, отбрасывается:
 * оно ничего не сделает, но раздует скрипт на полсотни строк.
 */
export function patchFor(schemaSql: string, gap: SchemaGap): string {
  if (gapIsEmpty(gap)) return "";
  const missingTables = new Set(gap.tables);
  const missingColumns = gap.columns;

  const kept: string[] = [];
  for (const statement of splitStatements(schemaSql)) {
    const code = body(statement);

    // Генератор идентификаторов нужен только новым таблицам.
    if (/create extension/i.test(code)) {
      if (missingTables.size) kept.push(statement);
      continue;
    }

    const createsTable = /create table if not exists public\.(\w+)/i.exec(code);
    if (createsTable && !missingTables.has(createsTable[1])) continue;

    const forMissingTable = [...missingTables].some((t) => mentionsWord(code, t));
    if (forMissingTable) {
      kept.push(statement);
      continue;
    }

    const forMissingColumn = missingColumns.some(
      (c) => mentionsWord(code, c.column) && mentionsWord(code, c.table)
    );
    if (forMissingColumn) kept.push(statement);
  }

  if (!kept.length) return "";
  return `-- Подготовка хранилища: только то, чего не хватает.\n${kept.join("\n\n")}\n`;
}

/** Человеческий перечень недостающего — чтобы было видно, за чем идём в базу. */
export function gapWords(gap: SchemaGap): string[] {
  const out = gap.tables.map((t) => `таблица «${t}»`);
  const byTable = new Map<string, string[]>();
  gap.columns.forEach(({ table, column }) => {
    const list = byTable.get(table) || [];
    list.push(column);
    byTable.set(table, list);
  });
  byTable.forEach((cols, table) => {
    out.push(`в таблице «${table}» — ${cols.map((c) => `«${c}»`).join(", ")}`);
  });
  return out;
}

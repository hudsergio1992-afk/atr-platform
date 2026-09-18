import { supabase } from "@/lib/supabaseClient";

/**
 * Какие поля таблицы база на самом деле знает.
 *
 * Схема обновляется вручную и отстаёт от приложения — тогда запись падает
 * целиком из-за одного незнакомого поля. Вместо этого спрашиваем базу заранее
 * и отправляем только то, что она принимает: часть возможностей деградирует,
 * но работа не встаёт.
 */
export async function detectMissingColumns(
  table: string,
  columns: string[]
): Promise<Set<string>> {
  const missing = new Set<string>();
  await Promise.all(
    columns.map(async (column) => {
      const { error } = await supabase.from(table).select(column).limit(1);
      if (!error) return;
      const code = error.code || "";
      const msg = error.message || "";
      const aboutThisColumn =
        msg.includes(column) || (error.details || "").includes(column);
      if ((code === "42703" || code === "PGRST204" || /does not exist|could not find/i.test(msg)) && aboutThisColumn) {
        missing.add(column);
      }
    })
  );
  return missing;
}

/** Убирает из записи поля, которых нет в базе. */
export function dropMissing<T extends Record<string, unknown>>(
  row: T,
  missing: Set<string>
): Partial<T> {
  if (!missing.size) return row;
  const out: Record<string, unknown> = {};
  Object.keys(row).forEach((key) => {
    if (!missing.has(key)) out[key] = row[key];
  });
  return out as Partial<T>;
}

/** Ключ сопоставления по названию, когда шифра в базе нет: регистр и пробелы не в счёт. */
export function nameKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ").replace(/[«»"']/g, "");
}

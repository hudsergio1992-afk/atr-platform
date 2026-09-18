/**
 * Человеческие сообщения вместо технических ответов PostgREST.
 * Прораб не должен читать «relation public.schedule_tasks does not exist».
 */

interface SupabaseLikeError {
  message?: string;
  code?: string;
  details?: string | null;
  hint?: string | null;
}

const SCHEMA_HINT = "Выполните supabase/schema.sql в SQL Editor проекта Supabase.";

export function dbErrorText(error: SupabaseLikeError | null | undefined, action: string): string {
  if (!error) return action;
  const code = error.code || "";
  const msg = error.message || "";

  // Таблицы нет вовсе. PGRST205 — та же беда словами PostgREST:
  // «Could not find the table ... in the schema cache».
  if (
    code === "42P01" ||
    code === "PGRST205" ||
    /relation .* does not exist/i.test(msg) ||
    /could not find the table/i.test(msg)
  ) {
    return `${action}: в базе нет нужной таблицы. ${SCHEMA_HINT}`;
  }
  // Колонка есть в приложении, но PostgREST её не видит — чаще всего устаревший кэш схемы.
  if (code === "PGRST204" || /could not find the .* column/i.test(msg)) {
    return `${action}: база не знает одного из полей. ${SCHEMA_HINT} Если скрипт уже выполнен — обновите кэш схемы: Settings → API → Reload schema cache.`;
  }
  // Таблица есть, но устарела — нет колонки, которую шлёт приложение.
  if (code === "42703" || /column .* does not exist/i.test(msg)) {
    return `${action}: база отстала от приложения — не хватает колонки. ${SCHEMA_HINT}`;
  }
  if (code === "23505") {
    return `${action}: такая запись уже есть.`;
  }
  if (code === "23503") {
    return `${action}: связанная запись не найдена или уже удалена. Обновите страницу.`;
  }
  if (code === "23514") {
    return `${action}: значение не проходит проверку базы (например, процент вне 0…100).`;
  }
  if (code === "42501" || /permission denied|row-level security/i.test(msg)) {
    return `${action}: база отказала в доступе. Проверьте политики доступа в Supabase. ${SCHEMA_HINT}`;
  }
  if (/Failed to fetch|NetworkError|fetch failed/i.test(msg)) {
    return `${action}: нет связи с базой. Проверьте интернет и настройки подключения.`;
  }
  if (/Invalid API key|JWT/i.test(msg)) {
    return `${action}: неверный ключ доступа к базе. Проверьте переменные окружения на Vercel.`;
  }
  return msg ? `${action}: ${msg}` : action;
}

import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL as string;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string;

if (!supabaseUrl || !supabaseKey) {
// Не бросаем исключение при сборке — просто предупреждаем в консоли браузера.
console.warn(
"Supabase env vars отсутствуют: проверьте NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY"
);
}

export const supabase = createClient(supabaseUrl, supabaseKey);

/**
 * Идентификатор проекта Supabase, к которому подключён сайт.
 * Нужен, чтобы владелец базы не готовил таблицы в соседнем проекте:
 * из адреса https://abcdefgh.supabase.co получается «abcdefgh».
 */
export function supabaseProjectRef(): string | null {
  if (!supabaseUrl) return null;
  try {
    const host = new URL(supabaseUrl).hostname;
    const ref = host.split(".")[0];
    return ref && ref !== "your-project" ? ref : null;
  } catch {
    return null;
  }
}

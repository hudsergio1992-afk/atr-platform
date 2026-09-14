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

// Кладёт схему БД в public/, чтобы сайт мог показать её прямо на странице:
// у владельца базы не должно быть повода ходить за текстом в репозиторий.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
mkdirSync(resolve(root, "public"), { recursive: true });
copyFileSync(resolve(root, "supabase/schema.sql"), resolve(root, "public/schema.sql"));
console.log("schema.sql скопирован в public/");

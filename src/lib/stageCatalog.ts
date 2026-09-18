import { supabase } from "@/lib/supabaseClient";
import { CatalogStage, TrackingMode } from "@/lib/types";
import { CUSTOM_SECTION, normalizeStageName } from "@/lib/stages";

/**
 * Работы, которые прораб сам сохранил в справочник.
 *
 * Хранятся в таблице stage_catalog: справочник общий, а не личный — работу,
 * сохранённую на объекте, должны видеть все. Пока таблицы в базе нет,
 * сохранённое лежит в браузере, помечается как местное и переносится
 * в базу при первой же возможности — иначе труд прораба пропал бы.
 */

const LS_KEY = "atr.stageCatalog";

export interface CatalogStageInput {
  section: string;
  name: string;
  unit: string | null;
  tracking: TrackingMode;
}

export interface CatalogLoadResult {
  items: CatalogStage[];
  /** true — база недоступна, список взят из браузера. */
  local: boolean;
  /** Ошибка базы, если она мешает работать со справочником. */
  error: unknown;
}

function readLocal(): CatalogStage[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is CatalogStage =>
        !!x && typeof x === "object" && typeof (x as CatalogStage).name === "string"
    );
  } catch {
    return [];
  }
}

function writeLocal(items: CatalogStage[]): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(items));
  } catch {
    /* приватный режим — сохранить не выйдет, но падать из-за этого нельзя */
  }
}

function toRow(input: CatalogStageInput): CatalogStage {
  return {
    id: `local-${Date.now()}-${Math.round(Math.random() * 1e6)}`,
    section: input.section.trim() || CUSTOM_SECTION,
    name: input.name.trim(),
    unit: input.unit && input.unit.trim() ? input.unit.trim() : null,
    tracking: input.tracking,
    created_at: new Date().toISOString(),
  };
}

/** Такая работа в этом разделе уже есть. */
function has(items: CatalogStage[], section: string, name: string): boolean {
  const s = normalizeStageName(section);
  const n = normalizeStageName(name);
  return items.some(
    (i) => normalizeStageName(i.section) === s && normalizeStageName(i.name) === n
  );
}

async function fetchAll(): Promise<{ items: CatalogStage[]; error: unknown }> {
  const { data, error } = await supabase
    .from("stage_catalog")
    .select("*")
    .order("section", { ascending: true })
    .order("name", { ascending: true });
  return { items: (data as CatalogStage[]) || [], error };
}

/**
 * Перенос в базу того, что осело в браузере, пока таблицы не было.
 * Обещание одно на все одновременные вызовы: иначе две вкладки — или строгий
 * режим React с его двойным запуском — перенесли бы одну работу дважды.
 */
let migration: Promise<void> | null = null;

async function migrateLocal(existing: CatalogStage[]): Promise<void> {
  if (!migration) {
    migration = (async () => {
      let done = true;
      for (const row of readLocal()) {
        if (has(existing, row.section, row.name)) continue;
        const { error } = await supabase.from("stage_catalog").insert({
          section: row.section,
          name: row.name,
          unit: row.unit,
          tracking: row.tracking,
        });
        // 23505 — работа уже в базе: цель достигнута, идём дальше.
        if (error && (error as { code?: string }).code !== "23505") done = false;
      }
      // Браузер чистим, только когда уехало всё до единой работы.
      if (done) writeLocal([]);
    })().finally(() => {
      migration = null;
    });
  }
  await migration;
}

export async function loadCatalogStages(): Promise<CatalogLoadResult> {
  const first = await fetchAll();
  // Таблицы ещё нет или база не отвечает — показываем сохранённое в браузере.
  if (first.error) return { items: readLocal(), local: true, error: first.error };
  if (!readLocal().length) return { items: first.items, local: false, error: null };

  await migrateLocal(first.items);
  const after = await fetchAll();
  return {
    items: after.error ? first.items : after.items,
    local: readLocal().length > 0,
    error: null,
  };
}

export interface CatalogSaveResult {
  item: CatalogStage;
  /** true — сохранить удалось только в браузере. */
  local: boolean;
  error: unknown;
}

export async function saveCatalogStage(input: CatalogStageInput): Promise<CatalogSaveResult> {
  const draft = toRow(input);
  const { data, error } = await supabase
    .from("stage_catalog")
    .insert({
      section: draft.section,
      name: draft.name,
      unit: draft.unit,
      tracking: draft.tracking,
    })
    .select()
    .single();

  if (!error && data) return { item: data as CatalogStage, local: false, error: null };
  // Работа уже в справочнике — считаем, что сохранена.
  if (error && (error as { code?: string }).code === "23505") {
    return { item: draft, local: false, error: null };
  }

  const local = readLocal();
  if (!has(local, draft.section, draft.name)) writeLocal(local.concat(draft));
  return { item: draft, local: true, error };
}

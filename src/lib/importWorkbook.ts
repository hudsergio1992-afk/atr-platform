import { BudgetLine, BudgetSection, ScheduleTask, SupplyRequest } from "@/lib/types";
import { parseCellDate, parseCellNumber } from "@/lib/importSchedule";

/**
 * Разбор «Книги объекта» (форма АТР-КО-01): листы «График производства работ»,
 * «Коммерческая смета», «График поставки материалов». Ведомость объёмов и ресурсов
 * — расчётные листы, на сайт не грузятся.
 *
 * Работа ГПР получает шифр = её № в книге (1, 2, 3 …). Поток становится разделом
 * графика. Позиция сметы привязывается к работе по столбцу «№ работы по ГПР»: в
 * название статьи бюджета ставится этот шифр — так считают экономию по закрытым работам.
 */

export type RowAction = "create" | "update" | "same" | "locked";

export interface Issue {
  sheet: string;
  line: number;
  text: string;
}

export interface GprRow {
  line: number;
  code: string;
  name: string;
  stream: string | null;
  startPlan: string | null;
  endPlan: string | null;
  /** Себестоимость работы — сумма привязанных к ней позиций сметы. null — привязок нет. */
  costTotal: number | null;
  action: RowAction;
  changes: string[];
  existingId: string | null;
}

export interface SmetaLine {
  line: number;
  name: string;
  section: BudgetSection;
  plan: number;
  note: string;
  workCode: string | null;
  action: RowAction;
  changes: string[];
  existingId: string | null;
}

export interface GpmRow {
  line: number;
  material: string;
  quantity: number | null;
  unit: string | null;
  workName: string | null;
  workCode: string | null;
  neededBy: string | null;
  note: string;
  action: RowAction;
  changes: string[];
  existingId: string | null;
}

export interface WorkbookPlan {
  gpr: { found: boolean; rows: GprRow[]; streams: string[]; errors: Issue[] };
  smeta: { found: boolean; lines: SmetaLine[]; errors: Issue[]; fileTotal: number | null; sum: number; linked: number; positions: number };
  gpm: { found: boolean; rows: GpmRow[]; errors: Issue[] };
  warnings: Issue[];
}

export interface WorkbookInput {
  sheets: { name: string; matrix: unknown[][] }[];
  tasks: ScheduleTask[];
  budget: BudgetLine[];
  supply: SupplyRequest[];
}

const SHEET_GPR = "График производства работ";
const SHEET_SMETA = "Коммерческая смета";
const SHEET_GPM = "График поставки материалов";

function norm(v: unknown): string {
  return String(v ?? "").trim().toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ");
}

const isBlank = (v: unknown) => v === null || v === undefined || String(v).trim() === "";

/** Целый номер из ячейки: 3, «3», «3.» — иначе null. */
function intOf(v: unknown): number | null {
  if (isBlank(v)) return null;
  const n = typeof v === "number" ? v : Number(String(v).trim().replace(/\.$/, ""));
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Количество «~10», «≈ 4,5», «120 шт» → число; «—» → null. */
function qtyOf(v: unknown): number | null {
  if (isBlank(v)) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const m = /-?\d[\d\s]*(?:[.,]\d+)?/.exec(String(v).replace(/[~≈]/g, ""));
  return m ? parseCellNumber(m[0]) : null;
}

const money = (n: number) => Math.round(n * 100) / 100;

function fmtRub(n: number): string {
  return `${money(n).toLocaleString("ru-RU")} ₽`;
}

function fmtDay(iso: string | null): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

/** Колонки листа по словам в заголовке: побеждает самое длинное совпадение. */
type ColRule = { key: string; test: (t: string) => number };
const has = (s: string) => (t: string) => (t.includes(s) ? s.length : 0);
const starts = (s: string) => (t: string) => (t.startsWith(s) ? s.length : 0);
const exact = (...s: string[]) => (t: string) => (s.includes(t) ? 50 : 0);

function mapRow(row: unknown[], rules: ColRule[]): Record<string, number> {
  const map: Record<string, number> = {};
  row.forEach((cell, i) => {
    const t = norm(cell);
    if (!t) return;
    let best: { key: string; score: number } | null = null;
    for (const r of rules) {
      const s = r.test(t);
      if (s > 0 && (!best || s > best.score)) best = { key: r.key, score: s };
    }
    if (best && map[best.key] === undefined) map[best.key] = i;
  });
  return map;
}

function findHeader(matrix: unknown[][], rules: ColRule[], need: string[]): { index: number; cols: Record<string, number> } | null {
  for (let i = 0; i < Math.min(matrix.length, 15); i++) {
    const cols = mapRow(matrix[i] || [], rules);
    if (need.every((k) => cols[k] !== undefined)) return { index: i, cols };
  }
  return null;
}

const GPR_RULES: ColRule[] = [
  { key: "num", test: exact("№", "№ п/п", "n") },
  { key: "name", test: (t) => Math.max(has("этап")(t), has("задача")(t), has("наименование")(t)) },
  { key: "stream", test: has("поток") },
  { key: "start", test: (t) => Math.max(has("дата начала")(t), starts("начало")(t)) },
  { key: "dur", test: has("длит") },
  { key: "end", test: (t) => Math.max(has("дата окончания")(t), starts("окончание")(t)) },
];

const SMETA_RULES: ColRule[] = [
  { key: "num", test: exact("№", "№ п/п") },
  { key: "name", test: has("наименование") },
  { key: "qty", test: (t) => Math.max(has("кол-во")(t), has("количество")(t)) },
  { key: "unit", test: starts("ед") },
  { key: "works", test: has("стоимость работ") },
  { key: "mats", test: has("материал") },
  { key: "equip", test: has("техник") },
  { key: "total", test: exact("всего") },
  { key: "link", test: has("гпр") },
];

const GPM_RULES: ColRule[] = [
  { key: "num", test: exact("№", "№ п/п") },
  { key: "name", test: (t) => Math.max(has("материал")(t), has("наименование")(t)) },
  { key: "unit", test: starts("ед") },
  { key: "qty", test: (t) => Math.max(has("кол-во")(t), has("количество")(t)) },
  { key: "work", test: has("связанная") },
  { key: "start", test: has("дата нач") },
  { key: "before", test: has("дн. до") },
  { key: "delivery", test: has("дата поставки") },
  { key: "lead", test: has("срок изг") },
  { key: "order", test: has("дата заказа") },
];

function sheetBy(sheets: WorkbookInput["sheets"], ...keys: string[]) {
  return sheets.find((s) => keys.some((k) => norm(s.name).includes(k)));
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function buildWorkbookPlan({ sheets, tasks, budget, supply }: WorkbookInput): WorkbookPlan {
  const warnings: Issue[] = [];
  const plan: WorkbookPlan = {
    gpr: { found: false, rows: [], streams: [], errors: [] },
    smeta: { found: false, lines: [], errors: [], fileTotal: null, sum: 0, linked: 0, positions: 0 },
    gpm: { found: false, rows: [], errors: [] },
    warnings,
  };

  /* ------------------------------ ГПР ------------------------------ */
  const gprSheet = sheetBy(sheets, "график производства", "гпр");
  const gprByCode = new Map<string, { name: string }>();
  if (gprSheet) {
    plan.gpr.found = true;
    const S = SHEET_GPR;
    const h = findHeader(gprSheet.matrix, GPR_RULES, ["num", "name", "start"]);
    if (!h) {
      plan.gpr.errors.push({ sheet: S, line: 0, text: "Не нашлась строка заголовков (№, Этап / задача, Дата начала)." });
    } else {
      const c = h.cols;
      const at = (row: unknown[], k: string) => (c[k] === undefined ? null : row[c[k]] ?? null);
      for (let i = h.index + 1; i < gprSheet.matrix.length; i++) {
        const row = gprSheet.matrix[i] || [];
        const line = i + 1;
        const name = String(at(row, "name") ?? "").trim();
        const rawNum = at(row, "num");
        if (!name && isBlank(rawNum)) continue;
        if (!name) {
          plan.gpr.errors.push({ sheet: S, line, text: `№ ${rawNum} — не заполнено наименование работы.` });
          continue;
        }
        if (/^потоки/i.test(name)) break; // легенда под таблицей
        const num = intOf(rawNum);
        if (num === null) {
          if (isBlank(rawNum)) warnings.push({ sheet: S, line, text: `«${name}» без № — строка пропущена.` });
          else plan.gpr.errors.push({ sheet: S, line, text: `«${name}»: № «${rawNum}» — нужно целое число.` });
          continue;
        }
        const code = String(num);
        if (gprByCode.has(code)) {
          plan.gpr.errors.push({ sheet: S, line, text: `№ ${code} встречается дважды.` });
          continue;
        }
        const startPlan = parseCellDate(at(row, "start"));
        if (!isBlank(at(row, "start")) && !startPlan) {
          plan.gpr.errors.push({ sheet: S, line, text: `№ ${code}: не разобрана дата начала «${String(at(row, "start"))}».` });
          continue;
        }
        let endPlan = parseCellDate(at(row, "end"));
        const dur = parseCellNumber(at(row, "dur"));
        if (!endPlan && startPlan && dur && dur > 0) endPlan = addDays(startPlan, Math.round(dur) - 1);
        if (startPlan && endPlan && endPlan < startPlan) {
          plan.gpr.errors.push({ sheet: S, line, text: `№ ${code}: окончание раньше начала.` });
          continue;
        }
        const stream = String(at(row, "stream") ?? "").trim() || null;
        if (stream && !plan.gpr.streams.includes(stream)) plan.gpr.streams.push(stream);
        gprByCode.set(code, { name });
        plan.gpr.rows.push({ line, code, name, stream, startPlan, endPlan, costTotal: null, action: "create", changes: [], existingId: null });
      }
      if (!plan.gpr.rows.length && !plan.gpr.errors.length) plan.gpr.found = false;
    }
  }

  /* ------------------------------ Смета ------------------------------ */
  const smetaSheet = sheetBy(sheets, "смет");
  const costByWork = new Map<string, number>();
  if (smetaSheet) {
    plan.smeta.found = true;
    const S = SHEET_SMETA;
    const h = findHeader(smetaSheet.matrix, SMETA_RULES, ["num", "name"]);
    if (!h || (h.cols.works === undefined && h.cols.mats === undefined && h.cols.equip === undefined)) {
      plan.smeta.errors.push({ sheet: S, line: 0, text: "Не нашлись столбцы сметы (№, Наименование, Стоимость работ / материалов / спецтехники)." });
    } else {
      const c = h.cols;
      const at = (row: unknown[], k: string) => (c[k] === undefined ? null : row[c[k]] ?? null);
      const knownCodes = new Set<string>([...gprByCode.keys(), ...tasks.map((t) => t.code).filter((x): x is string => !!x)]);
      const usedNames = new Set<string>();
      let section = "";
      const parts: { key: string; section: BudgetSection; label: string }[] = [
        { key: "works", section: "works", label: "работы" },
        { key: "mats", section: "materials", label: "материалы" },
        { key: "equip", section: "equipment", label: "техника" },
      ];
      for (let i = h.index + 1; i < smetaSheet.matrix.length; i++) {
        const row = smetaSheet.matrix[i] || [];
        const line = i + 1;
        const first = String(row.find((v) => !isBlank(v)) ?? "").trim();
        if (!first) continue;
        const firstN = norm(first);
        if (firstN.startsWith("раздел")) {
          section = first;
          continue;
        }
        if (firstN.startsWith("прямые затраты")) {
          const v = parseCellNumber(at(row, "total"));
          if (v !== null) plan.smeta.fileTotal = v;
          continue;
        }
        const num = intOf(at(row, "num"));
        const name = String(at(row, "name") ?? "").trim();
        if (num === null || !name) continue; // итоги, накладные %, пояснения
        const amounts = parts
          .map((p) => ({ ...p, v: parseCellNumber(at(row, p.key)) }))
          .filter((p): p is typeof p & { v: number } => p.v !== null && p.v !== 0);
        if (amounts.some((a) => a.v < 0)) {
          plan.smeta.errors.push({ sheet: S, line, text: `Позиция ${num} «${name}»: отрицательная стоимость.` });
          continue;
        }
        if (!amounts.length) {
          warnings.push({ sheet: S, line, text: `Позиция ${num} «${name}» без стоимости — пропущена.` });
          continue;
        }
        plan.smeta.positions += 1;
        let workCode: string | null = null;
        const rawLink = at(row, "link");
        if (!isBlank(rawLink)) {
          const code = String(intOf(rawLink) ?? String(rawLink).trim());
          if (knownCodes.has(code)) workCode = code;
          else warnings.push({ sheet: S, line, text: `Позиция ${num}: работы № ${String(rawLink)} нет в ГПР — грузится без привязки.` });
        }
        if (workCode) {
          plan.smeta.linked += 1;
          costByWork.set(workCode, (costByWork.get(workCode) || 0) + amounts.reduce((s, a) => s + a.v, 0));
        }
        const qty = qtyOf(at(row, "qty"));
        const unit = String(at(row, "unit") ?? "").trim();
        const noteParts = [section, qty !== null ? `${qty.toLocaleString("ru-RU")} ${unit}`.trim() : "", `поз. ${num} сметы`].filter(Boolean);
        for (const a of amounts) {
          // Название без шифра не должно начинаться с цифр — иначе сайт примет их за шифр работы.
          const base = workCode ? `${workCode} ${name}` : /^\d+(?:\.\d+)*\s/.test(name) ? `Поз. ${name}` : name;
          let lineName = amounts.length > 1 ? `${base} — ${a.label}` : base;
          if (usedNames.has(lineName)) lineName = `${lineName} (поз. ${num})`;
          usedNames.add(lineName);
          plan.smeta.sum += a.v;
          plan.smeta.lines.push({
            line,
            name: lineName,
            section: a.section,
            plan: money(a.v),
            note: `Из книги объекта: ${noteParts.join("; ")}`,
            workCode,
            action: "create",
            changes: [],
            existingId: null,
          });
        }
      }
      plan.smeta.sum = money(plan.smeta.sum);
      const byName = new Map(budget.map((b) => [b.name.trim(), b]));
      for (const l of plan.smeta.lines) {
        const old = byName.get(l.name);
        if (!old) continue;
        l.existingId = old.id;
        if (Number(old.plan_amount) !== l.plan) {
          l.action = "update";
          l.changes.push(`План: ${fmtRub(Number(old.plan_amount))} → ${fmtRub(l.plan)}`);
        } else l.action = "same";
      }
    }
  }

  /* -------------------- ГПР: сверка с этапами на сайте -------------------- */
  const taskByCode = new Map(tasks.filter((t) => t.code).map((t) => [t.code as string, t]));
  for (const r of plan.gpr.rows) {
    if (costByWork.has(r.code)) r.costTotal = money(costByWork.get(r.code) || 0);
    const old = taskByCode.get(r.code);
    if (!old) continue;
    r.existingId = old.id;
    if (old.name !== r.name) r.changes.push(`Наименование: ${old.name} → ${r.name}`);
    if ((old.start_plan || null) !== r.startPlan) r.changes.push(`Начало: ${fmtDay(old.start_plan)} → ${fmtDay(r.startPlan)}`);
    if ((old.end_plan || null) !== r.endPlan) r.changes.push(`Окончание: ${fmtDay(old.end_plan)} → ${fmtDay(r.endPlan)}`);
    if (r.costTotal !== null && Number(old.cost_total ?? NaN) !== r.costTotal)
      r.changes.push(`Стоимость: ${old.cost_total != null ? fmtRub(Number(old.cost_total)) : "—"} → ${fmtRub(r.costTotal)}`);
    r.action = r.changes.length ? "update" : "same";
  }

  /* ------------------------------ ГПМ ------------------------------ */
  const gpmSheet = sheetBy(sheets, "график поставки", "гпм");
  if (gpmSheet) {
    plan.gpm.found = true;
    const S = SHEET_GPM;
    const h = findHeader(gpmSheet.matrix, GPM_RULES, ["num", "name"]);
    if (!h) {
      plan.gpm.errors.push({ sheet: S, line: 0, text: "Не нашлась строка заголовков (№, Материал / оборудование)." });
    } else {
      const c = h.cols;
      const at = (row: unknown[], k: string) => (c[k] === undefined ? null : row[c[k]] ?? null);
      const codeByWorkName = new Map<string, string>();
      gprByCode.forEach((v, code) => codeByWorkName.set(norm(v.name), code));
      tasks.forEach((t) => {
        if (t.code && !codeByWorkName.has(norm(t.name))) codeByWorkName.set(norm(t.name), t.code);
      });
      for (let i = h.index + 1; i < gpmSheet.matrix.length; i++) {
        const row = gpmSheet.matrix[i] || [];
        const line = i + 1;
        const num = intOf(at(row, "num"));
        const material = String(at(row, "name") ?? "").trim();
        if (num === null || !material) continue; // пустые строки, обозначения
        const quantity = qtyOf(at(row, "qty"));
        const unit = String(at(row, "unit") ?? "").trim() || null;
        if (quantity !== null && quantity < 0) {
          plan.gpm.errors.push({ sheet: S, line, text: `${num}. «${material}»: отрицательное количество.` });
          continue;
        }
        const workName = String(at(row, "work") ?? "").trim() || null;
        const workCode = workName ? codeByWorkName.get(norm(workName)) || null : null;
        if (workName && !workCode) warnings.push({ sheet: S, line, text: `${num}. «${material}»: работы «${workName}» нет в ГПР — заявка без привязки к работе.` });
        let neededBy = parseCellDate(at(row, "delivery"));
        if (!neededBy) {
          const start = parseCellDate(at(row, "start"));
          const before = parseCellNumber(at(row, "before")) || 0;
          if (start) neededBy = addDays(start, -Math.round(before));
        }
        const orderBy = parseCellDate(at(row, "order"));
        const lead = parseCellNumber(at(row, "lead"));
        const rawQty = at(row, "qty");
        const noteParts = [
          workName && !workCode ? `Работа: ${workName}` : "",
          orderBy ? `заказать до ${fmtDay(orderBy)}` : "",
          lead ? `срок изготовления ${lead} дн.` : "",
          typeof rawQty === "string" && quantity !== null && /[~≈]/.test(rawQty) ? `кол-во ориентировочно (${rawQty.trim()})` : "",
        ].filter(Boolean);
        plan.gpm.rows.push({
          line,
          material,
          quantity,
          unit,
          workName,
          workCode,
          neededBy,
          note: `Из ГПМ книги объекта${noteParts.length ? ": " + noteParts.join("; ") : ""}`,
          action: "create",
          changes: [],
          existingId: null,
        });
      }
      // Существующие заявки: по материалу и работе.
      const taskIdByCode = new Map(tasks.filter((t) => t.code).map((t) => [t.code as string, t.id]));
      for (const r of plan.gpm.rows) {
        const taskId = r.workCode ? taskIdByCode.get(r.workCode) || null : null;
        const old = supply.find(
          (s) => norm(s.material_name) === norm(r.material) && (s.task_id || null) === taskId && s.status !== "cancelled"
        );
        if (!old) continue;
        r.existingId = old.id;
        const changes: string[] = [];
        if (Number(old.quantity ?? NaN) !== (r.quantity ?? NaN) && !(old.quantity == null && r.quantity == null))
          changes.push(`Кол-во: ${old.quantity ?? "—"} → ${r.quantity ?? "—"}`);
        if ((old.unit || null) !== r.unit) changes.push(`Ед.: ${old.unit || "—"} → ${r.unit || "—"}`);
        if ((old.needed_by || null) !== r.neededBy) changes.push(`Нужно к: ${fmtDay(old.needed_by)} → ${fmtDay(r.neededBy)}`);
        r.changes = changes;
        if (!changes.length) r.action = "same";
        else if (old.status === "draft" || old.status === "pricing") r.action = "update";
        else r.action = "locked";
      }
    }
  }

  // Пустой лист формы (шаблон без данных) — как будто его нет.
  if (!plan.smeta.lines.length && !plan.smeta.errors.length) plan.smeta.found = false;
  if (!plan.gpm.rows.length && !plan.gpm.errors.length) plan.gpm.found = false;
  return plan;
}

export const ACTION_LABEL: Record<RowAction, string> = {
  create: "новая",
  update: "обновится",
  same: "без изменений",
  locked: "уже в работе — не трогаем",
};

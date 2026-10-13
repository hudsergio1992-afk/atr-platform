/* eslint-disable @typescript-eslint/no-explicit-any -- ExcelJS грузится с cdnjs, своих типов в сборке нет */

/**
 * Форма АТР-КО-01 «Книга объекта»: ведомость объёмов, коммерческая смета, ресурсы,
 * ГПР и ГПМ. Собирается прямо в браузере (ExcelJS с cdnjs), во вторую строку каждого
 * листа подставляется объект. Заполненная книга загружается обратно в «Объектах».
 */

const EXCELJS_URL = "https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js";
export const FORM_CODE = "АТР-КО-01";
const REV = "Форма АТР-КО-01, ред. 1 от 13.10.2026";

export function loadExcelJs(): Promise<any> {
  const w = window as unknown as { ExcelJS?: any };
  if (w.ExcelJS) return Promise.resolve(w.ExcelJS);
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = EXCELJS_URL;
    s.onload = () => (w.ExcelJS ? resolve(w.ExcelJS) : reject(new Error("Excel-библиотека не загрузилась")));
    s.onerror = () => reject(new Error("Нет связи с cdnjs — Excel-библиотека не загрузилась"));
    document.head.appendChild(s);
  });
}

const TNR = "Times New Roman";
const TITLE = "1F3864", HEAD = "2E5496", SECT = "D6E0F0", TOTAL = "BDD7EE", GRAND = "FFE699", INP = "FFF2CC", LINK = "E2EFDA";
const MONEY = '#,##0" ₽";[Red]\\(#,##0" ₽)";\\–';
const DATE = "dd.mm.yyyy";
const THIN = { style: "thin", color: { argb: "FFBFBFBF" } };
const BT = { top: THIN, left: THIN, bottom: THIN, right: THIN };
const argb = (c: string) => ({ argb: "FF" + c });
const fill = (c: string) => ({ type: "pattern", pattern: "solid", fgColor: argb(c) });
const font = (o: { size?: number; bold?: boolean; italic?: boolean; color?: string } = {}) => ({
  name: TNR, size: o.size ?? 9, bold: !!o.bold, italic: !!o.italic, color: argb(o.color ?? "000000"),
});

/** Буква столбца по номеру (1 → A). */
function L(n: number): string {
  let s = "";
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

type Opt = { fmt?: string; al?: "left" | "center" | "right"; bold?: boolean; color?: string; bg?: string; size?: number; wrap?: boolean };
function cellFmt(c: any, o: Opt = {}) {
  c.font = font({ size: o.size, bold: o.bold, color: o.color });
  c.border = BT;
  c.alignment = { horizontal: o.al ?? "left", vertical: "middle", wrapText: o.wrap ?? true };
  if (o.fmt) c.numFmt = o.fmt;
  if (o.bg) c.fill = fill(o.bg);
}

function widths(ws: any, w: number[]) {
  w.forEach((x, i) => (ws.getColumn(i + 1).width = x));
}

function title(ws: any, text: string, ncols: number, sub: string, h1 = 25.5) {
  ws.mergeCells(1, 1, 1, ncols);
  const c = ws.getCell(1, 1);
  c.value = text; c.font = font({ size: 14, bold: true, color: "FFFFFF" }); c.fill = fill(TITLE);
  c.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  ws.getRow(1).height = h1;
  ws.mergeCells(2, 1, 2, ncols);
  const d = ws.getCell(2, 1);
  d.value = sub; d.font = font({ italic: true, color: "333333" }); d.fill = fill(INP);
  d.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  d.note = "Объект, адрес, заказчик, договор.";
  ws.getRow(2).height = 30;
}

function head(ws: any, row: number, titles: string[], height = 30, size = 10) {
  titles.forEach((t, i) => {
    const c = ws.getCell(row, i + 1);
    c.value = t; c.font = font({ size, bold: true, color: "FFFFFF" }); c.fill = fill(HEAD); c.border = BT;
    c.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  });
  ws.getRow(row).height = height;
}

const SECTIONS = 3;
const ROWS_PER = 15;

function sheetVor(wb: any, sub: string) {
  const ws = wb.addWorksheet("Ведомость материалов и работ", { views: [{ state: "frozen", ySplit: 3 }] });
  widths(ws, [6, 62, 12, 10, 26]);
  title(ws, "ВЕДОМОСТЬ ОБЪЁМОВ РАБОТ И МАТЕРИАЛОВ", 5, sub);
  head(ws, 3, ["№", "Наименование работ и материалов", "Кол-во", "Ед. изм.", "Источник / примечание"]);
  let r = 4;
  for (let s = 1; s <= SECTIONS; s++) {
    ws.mergeCells(r, 1, r, 5);
    const c = ws.getCell(r, 1);
    c.value = `Раздел ${s}. `; cellFmt(c, { bold: true, color: TITLE, bg: SECT, size: 10 });
    r++;
    for (let i = 0; i < ROWS_PER; i++, r++) {
      cellFmt(ws.getCell(r, 1), { al: "center" });
      cellFmt(ws.getCell(r, 2), { bg: INP });
      cellFmt(ws.getCell(r, 3), { fmt: "#,##0.00;;\\–", al: "center", bg: INP });
      cellFmt(ws.getCell(r, 4), { al: "center", bg: INP });
      cellFmt(ws.getCell(r, 5), { bg: INP });
    }
  }
}

function sheetSmeta(wb: any, sub: string) {
  const ws = wb.addWorksheet("Коммерческая смета", { views: [{ state: "frozen", ySplit: 3 }] });
  widths(ws, [5, 52, 9, 8, 14, 14, 14, 15, 11]);
  title(ws, "КОММЕРЧЕСКАЯ СМЕТА", 9, sub);
  head(ws, 3, ["№", "Наименование", "Кол-во", "Ед.изм.", "Стоимость работ", "Стоимость материалов / оборуд.", "Стоимость спецтехники", "Всего", "№ работы по ГПР"], 39.75, 9);
  ws.getCell(3, 9).note =
    "Номер работы с листа «График производства работ», к которой относится позиция. По нему сайт связывает затраты с работой: стоимость работы в графике = сумма её позиций, экономия/перерасход — по закрытым работам. Пусто — позиция грузится без привязки.";
  let r = 4;
  for (let s = 1; s <= SECTIONS; s++) {
    ws.mergeCells(r, 1, r, 9);
    const c = ws.getCell(r, 1);
    c.value = `Раздел ${s}. `; cellFmt(c, { bold: true, color: TITLE, bg: SECT, size: 10 });
    const first = ++r;
    for (let i = 0; i < ROWS_PER; i++, r++) {
      cellFmt(ws.getCell(r, 1), { al: "center" });
      cellFmt(ws.getCell(r, 2), { bg: INP });
      cellFmt(ws.getCell(r, 3), { fmt: "#,##0.##", al: "center", bg: INP });
      cellFmt(ws.getCell(r, 4), { al: "center", bg: INP });
      for (const col of [5, 6, 7]) cellFmt(ws.getCell(r, col), { fmt: MONEY, al: "right", bg: INP });
      const h = ws.getCell(r, 8);
      cellFmt(h, { fmt: MONEY, al: "right" });
      h.value = { formula: `IF(COUNT(E${r}:G${r})=0,"",SUM(E${r}:G${r}))` };
      cellFmt(ws.getCell(r, 9), { al: "center", bg: INP, fmt: "@" });
    }
    ws.mergeCells(r, 1, r, 4);
    const t = ws.getCell(r, 1);
    t.value = "Итого по разделу"; cellFmt(t, { bold: true, bg: TOTAL, al: "right" });
    for (let col = 5; col <= 8; col++) {
      const x = ws.getCell(r, col);
      cellFmt(x, { fmt: MONEY, al: "right", bold: true, bg: TOTAL });
      x.value = { formula: `SUM(${L(col)}${first}:${L(col)}${r - 1})` };
    }
    cellFmt(ws.getCell(r, 9), { bg: TOTAL });
    r++;
  }
  const direct = r;
  ws.mergeCells(r, 1, r, 4);
  const d = ws.getCell(r, 1);
  d.value = "ПРЯМЫЕ ЗАТРАТЫ (себестоимость), всего"; cellFmt(d, { bold: true, bg: GRAND, al: "right", size: 10 });
  for (let col = 5; col <= 8; col++) {
    const x = ws.getCell(r, col);
    cellFmt(x, { fmt: MONEY, al: "right", bold: true, bg: GRAND, size: 10 });
    x.value = { formula: `SUMIF($A$4:$A$${r - 1},"Итого по разделу",${L(col)}$4:${L(col)}$${r - 1})` };
  }
  cellFmt(ws.getCell(r, 9), { bg: GRAND });
  r += 2;
  ws.getCell(r, 2).value = "Накладные расходы и сметная прибыль, %";
  ws.getCell(r, 2).font = font({ size: 10, bold: true });
  const pct = ws.getCell(r, 8);
  pct.value = 0.15; cellFmt(pct, { fmt: "0%", al: "center", bold: true, color: "0000FF", bg: INP, size: 10 });
  const pctRow = r++;
  ws.getCell(r, 2).value = "Сумма накладных расходов и прибыли";
  ws.getCell(r, 2).font = font({ size: 10 });
  const ovh = ws.getCell(r, 8);
  ovh.value = { formula: `H${direct}*H${pctRow}` }; cellFmt(ovh, { fmt: MONEY, al: "right", size: 10 });
  const ovhRow = r++;
  ws.mergeCells(r, 2, r, 7);
  const it = ws.getCell(r, 2);
  it.value = "ИТОГО КОММЕРЧЕСКАЯ СТОИМОСТЬ ОБЪЕКТА (с НДС)";
  it.font = font({ size: 12, bold: true, color: "FFFFFF" }); it.fill = fill(TITLE); it.alignment = { horizontal: "right", vertical: "middle" };
  const tot = ws.getCell(r, 8);
  tot.value = { formula: `H${direct}+H${ovhRow}` };
  tot.font = font({ size: 12, bold: true, color: "FFFFFF" }); tot.fill = fill(TITLE); tot.numFmt = MONEY;
  const med = { style: "medium", color: argb(TITLE) };
  tot.border = { top: med, left: med, bottom: med, right: med };
  tot.alignment = { horizontal: "right", vertical: "middle" };
  r += 2;
  const n = ws.getCell(r, 2);
  n.value =
    "Синяя ячейка процента — изменяемый параметр. Жёлтые — заполняются. Новые позиции добавляйте вставкой строк ВНУТРИ раздела (до «Итого по разделу») — итоги посчитаются сами. Новый раздел — копией блока «Раздел … / Итого по разделу».";
  n.font = font({ size: 8, italic: true, color: "808080" }); n.alignment = { wrapText: true };
  ws.getRow(r).height = 36;
}

const GW = 60, GDAYS = 200, G0 = 7, GLAST = 5 + GW;
const STREAMS: [string, string][] = [
  ["Подготовка", "7F7F7F"], ["Заводское изг.", "BF9000"], ["Поставка", "C55A11"], ["Фундаменты", "2E75B6"],
  ["Металлоконструкции", "548235"], ["Узел очистки", "9E480E"], ["Оборудование", "7030A0"], ["Доп. работы", "1F6B75"],
  ["ЭОМ", "C00000"], ["ПНР", "203864"],
];
const GPR = "'График производства работ'";
const GPR_NAMES = `${GPR}!$B$6:$B$${GLAST}`;

function scaleHead(ws: any, firstCol: number, days: number, startRef: string) {
  for (let i = 0; i < days; i++) {
    const col = L(firstCol + i);
    const c5 = ws.getCell(5, firstCol + i);
    c5.value = { formula: `${startRef}+${i}` }; c5.numFmt = "dd"; c5.font = font({ size: 6, color: "FFFFFF" }); c5.fill = fill(HEAD);
    c5.alignment = { horizontal: "center", textRotation: 90 }; c5.border = BT;
    const c4 = ws.getCell(4, firstCol + i);
    c4.value = { formula: `IF(OR(COLUMN()=${firstCol},DAY(${col}5)=1),${col}5,"")` }; c4.numFmt = "mmm yyyy";
    c4.font = font({ size: 8, bold: true, color: "FFFFFF" }); c4.fill = fill(HEAD);
    ws.getColumn(firstCol + i).width = 2.3;
  }
}

function sheetGpr(wb: any, sub: string) {
  const ws = wb.addWorksheet("График производства работ", { views: [{ state: "frozen", xSplit: G0 - 1, ySplit: 5 }] });
  widths(ws, [4, 48, 15, 13, 8, 13]);
  ws.mergeCells(1, 1, 1, 30);
  const t = ws.getCell(1, 1);
  t.value = "ГРАФИК ПРОИЗВОДСТВА РАБОТ"; t.font = font({ size: 14, bold: true, color: "FFFFFF" }); t.fill = fill(TITLE);
  t.alignment = { horizontal: "left", vertical: "middle", indent: 1 };
  ws.getRow(1).height = 24;
  ws.mergeCells(2, 1, 2, 6);
  const s = ws.getCell(2, 1);
  s.value = sub; s.font = font({ italic: true, color: "333333" }); s.fill = fill(INP);
  s.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  ws.getRow(2).height = 30;
  ws.getCell(3, 2).value = "Начало календарной шкалы:";
  ws.getCell(3, 2).font = font({ size: 10, bold: true }); ws.getCell(3, 2).alignment = { horizontal: "right" };
  const c3 = ws.getCell(3, 3);
  c3.value = { formula: `IF(COUNT(D6:D${GLAST})=0,TODAY(),MIN(D6:D${GLAST}))` };
  c3.font = font({ size: 10, bold: true, color: "008000" }); c3.fill = fill(LINK); c3.numFmt = DATE; c3.border = BT;
  c3.alignment = { horizontal: "center" };
  c3.note = "Считается сама — самая ранняя дата начала. Можно вписать свою дату вместо формулы.";
  ["№", "Этап / задача", "Поток", "Дата начала", "Длит. (дн.)", "Дата окончания"].forEach((h, i) => {
    ws.mergeCells(4, i + 1, 5, i + 1);
    const c = ws.getCell(4, i + 1);
    c.value = h; c.font = font({ size: 8, bold: true, color: "FFFFFF" }); c.fill = fill(HEAD); c.border = BT;
    c.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  });
  ws.getRow(4).height = 13.5;
  ws.getRow(5).height = 33.75;
  scaleHead(ws, G0, GDAYS, "$C$3");
  for (let r = 6; r <= GLAST; r++) {
    cellFmt(ws.getCell(r, 1), { al: "center", size: 8, bg: INP });
    cellFmt(ws.getCell(r, 2), { size: 8, bg: INP });
    cellFmt(ws.getCell(r, 3), { al: "center", size: 8, bg: INP });
    cellFmt(ws.getCell(r, 4), { fmt: DATE, al: "center", bold: true, color: "0000FF", bg: INP });
    cellFmt(ws.getCell(r, 5), { al: "center", bold: true, color: "0000FF", bg: INP });
    const f = ws.getCell(r, 6);
    cellFmt(f, { fmt: DATE, al: "center", size: 8 });
    f.value = { formula: `IF(OR(D${r}="",E${r}=""),"",D${r}+E${r}-1)` };
    ws.getCell(r, 1).dataValidation = { type: "whole", operator: "between", formulae: [1, 999], allowBlank: true, showErrorMessage: true, errorTitle: "№", error: "Номер работы — целое число 1, 2, 3 … без повторов" };
    ws.getCell(r, 4).dataValidation = { type: "date", operator: "greaterThan", formulae: [new Date(2020, 0, 1)], allowBlank: true, showErrorMessage: true, errorTitle: "Дата", error: "Дата в виде ДД.ММ.ГГГГ" };
    ws.getCell(r, 5).dataValidation = { type: "whole", operator: "between", formulae: [1, 1000], allowBlank: true, showErrorMessage: true, errorTitle: "Длительность", error: "Целое число календарных дней, от 1" };
  }
  const leg = GLAST + 3;
  ws.getCell(leg - 1, 2).value = "Потоки (цвет полосы) — названия можно менять, цвет останется за строкой:";
  ws.getCell(leg - 1, 2).font = font({ size: 8, bold: true });
  STREAMS.forEach(([name, color], k) => {
    const sw = ws.getCell(leg + k, 2);
    sw.fill = fill(color); sw.border = BT;
    const c = ws.getCell(leg + k, 3);
    c.value = name; c.font = font({ size: 8 }); c.border = BT; c.fill = fill(INP);
  });
  for (let r = 6; r <= GLAST; r++) {
    ws.getCell(r, 3).dataValidation = { type: "list", allowBlank: true, formulae: [`$C$${leg}:$C$${leg + STREAMS.length - 1}`], showErrorMessage: false };
  }
  const scale = `${L(G0)}6:${L(G0 + GDAYS - 1)}${GLAST}`;
  const K = L(G0);
  const rules: any[] = STREAMS.map(([, color], k) => ({
    type: "expression", priority: k + 1, stopIfTrue: true,
    formulae: [`AND($C6=$C$${leg + k},$D6<>"",$F6<>"",${K}$5>=$D6,${K}$5<=$F6)`],
    style: { fill: { type: "pattern", pattern: "solid", bgColor: argb(color) } },
  }));
  rules.push({
    type: "expression", priority: STREAMS.length + 1,
    formulae: [`AND($D6<>"",$F6<>"",${K}$5>=$D6,${K}$5<=$F6)`],
    style: { fill: { type: "pattern", pattern: "solid", bgColor: argb("A6A6A6") } },
  });
  ws.addConditionalFormatting({ ref: scale, rules });
  ws.addConditionalFormatting({
    ref: `${K}5:${L(G0 + GDAYS - 1)}5`,
    rules: [{ type: "expression", priority: 1, formulae: [`${K}$5=TODAY()`], style: { fill: { type: "pattern", pattern: "solid", bgColor: argb("C00000") } } }],
  });
  ws.addConditionalFormatting({
    ref: `C6:C${GLAST}`,
    rules: STREAMS.map(([, color], k) => ({
      type: "expression", priority: k + 1, stopIfTrue: true,
      formulae: [`AND($C6<>"",$C6=$C$${leg + k})`],
      style: { fill: { type: "pattern", pattern: "solid", bgColor: argb(color) }, font: { color: argb("FFFFFF") } },
    })),
  });
}

function sheetResources(wb: any, sub: string) {
  const ws = wb.addWorksheet("Ведомость ресурсов", { views: [{ state: "frozen", ySplit: 3 }] });
  widths(ws, [42, 14, 40, 11, 10]);
  title(ws, "ВЕДОМОСТЬ ПОТРЕБНОСТИ В РЕСУРСАХ ПО РАБОТАМ", 5, sub, 24);
  head(ws, 3, ["Наименование работ", "Тип", "Наименование ресурса", "Количество", "Ед. изм."], 27.75);
  const last = 3 + 120;
  const types: [string, string, string][] = [
    ["Рабочая сила", "E2EFDA", "375623"], ["Машина", "DEEBF7", "1F4E79"], ["Материал", "FFF2CC", "7F6000"], ["Другое", "F2F2F2", "595959"],
  ];
  for (let r = 4; r <= last; r++) {
    cellFmt(ws.getCell(r, 1), { bold: true, color: TITLE, bg: INP });
    cellFmt(ws.getCell(r, 2), { al: "center", bold: true, bg: INP });
    cellFmt(ws.getCell(r, 3), { bg: INP });
    cellFmt(ws.getCell(r, 4), { fmt: "0.##", al: "center", bg: INP });
    cellFmt(ws.getCell(r, 5), { al: "center", bg: INP });
    ws.getCell(r, 1).dataValidation = { type: "list", allowBlank: true, formulae: [GPR_NAMES], showErrorMessage: false };
    ws.getCell(r, 2).dataValidation = { type: "list", allowBlank: true, formulae: [`"${types.map((t) => t[0]).join(",")}"`], showErrorMessage: true, errorTitle: "Тип", error: "Рабочая сила, Машина, Материал или Другое" };
  }
  ws.addConditionalFormatting({
    ref: `B4:B${last}`,
    rules: types.map(([name, bg, fg], k) => ({
      type: "expression", priority: k + 1, formulae: [`$B4="${name}"`],
      style: { fill: { type: "pattern", pattern: "solid", bgColor: argb(bg) }, font: { color: argb(fg), bold: true } },
    })),
  });
  const n = ws.getCell(last + 2, 1);
  n.value = "Работу выбирайте из списка (берётся с листа ГПР). Для следующих ресурсов той же работы столбец A можно оставить пустым.";
  n.font = font({ size: 8, italic: true, color: "808080" });
}

function sheetGpm(wb: any) {
  const MW = 60, MDAYS = 200, M0 = 11, MLAST = 5 + MW;
  const ws = wb.addWorksheet("График поставки материалов", { views: [{ state: "frozen", xSplit: M0 - 1, ySplit: 5 }] });
  widths(ws, [4, 42, 6, 8, 30, 13, 7, 13, 7, 13]);
  ws.mergeCells(1, 1, 1, 30);
  const t = ws.getCell(1, 1);
  t.value = "ГРАФИК ПОСТАВКИ МАТЕРИАЛОВ И ОБОРУДОВАНИЯ"; t.font = font({ size: 14, bold: true, color: "FFFFFF" }); t.fill = fill(TITLE);
  t.alignment = { horizontal: "left", vertical: "middle", indent: 1 };
  ws.getRow(1).height = 24;
  ws.mergeCells(2, 1, 2, 10);
  const s = ws.getCell(2, 1);
  s.value = "«Дата нач. работ» подтягивается с листа ГПР по выбранной работе. Дата поставки = начало работ − «Дн. до». Дата заказа = поставка − срок изготовления.";
  s.font = font({ italic: true, color: "333333" }); s.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  ws.getRow(2).height = 30;
  ws.getCell(3, 2).value = "Начало календарной шкалы (ранняя дата заказа или начало ГПР):";
  ws.getCell(3, 2).font = font({ bold: true }); ws.getCell(3, 2).alignment = { horizontal: "right" };
  const f3 = ws.getCell(3, 6);
  f3.value = { formula: `IF(COUNT(J6:J${MLAST})=0,${GPR}!$C$3,MIN(${GPR}!$C$3,MIN(J6:J${MLAST})))` };
  f3.font = font({ size: 10, bold: true, color: "008000" }); f3.fill = fill(LINK); f3.numFmt = DATE; f3.border = BT; f3.alignment = { horizontal: "center" };
  ["№", "Материал / оборудование", "Ед.", "Кол-во", "Связанная работа", "Дата нач. работ", "Дн. до", "Дата поставки", "Срок изг.", "Дата заказа"].forEach((h, i) => {
    ws.mergeCells(4, i + 1, 5, i + 1);
    const c = ws.getCell(4, i + 1);
    c.value = h; c.font = font({ size: 8, bold: true, color: "FFFFFF" }); c.fill = fill(HEAD); c.border = BT;
    c.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  });
  ws.getRow(4).height = 13.5;
  ws.getRow(5).height = 39.75;
  scaleHead(ws, M0, MDAYS, "$F$3");
  for (let r = 6; r <= MLAST; r++) {
    cellFmt(ws.getCell(r, 1), { al: "center", size: 8, bg: INP });
    cellFmt(ws.getCell(r, 2), { size: 8, bg: INP });
    cellFmt(ws.getCell(r, 3), { al: "center", size: 8, bg: INP });
    cellFmt(ws.getCell(r, 4), { al: "center", size: 8, bg: INP });
    cellFmt(ws.getCell(r, 5), { size: 7, color: "555555", bg: INP });
    const f = ws.getCell(r, 6);
    f.value = { formula: `IF($E${r}="","",IFERROR(INDEX(${GPR}!$D$6:$D$${GLAST},MATCH($E${r},${GPR}!$B$6:$B$${GLAST},0)),"нет в ГПР"))` };
    cellFmt(f, { fmt: DATE, al: "center", size: 8, color: "008000", bg: LINK });
    cellFmt(ws.getCell(r, 7), { al: "center", size: 8, bold: true, color: "0000FF", bg: INP });
    const h = ws.getCell(r, 8);
    h.value = { formula: `IF(ISNUMBER(F${r}),F${r}-N(G${r}),"")` };
    cellFmt(h, { fmt: DATE, al: "center", size: 8 });
    cellFmt(ws.getCell(r, 9), { al: "center", size: 8, bold: true, color: "0000FF", bg: INP });
    const j = ws.getCell(r, 10);
    j.value = { formula: `IF(ISNUMBER(H${r}),H${r}-N(I${r}),"")` };
    cellFmt(j, { fmt: DATE, al: "center", size: 8, color: "C55A11" });
    ws.getCell(r, 5).dataValidation = { type: "list", allowBlank: true, formulae: [GPR_NAMES], showErrorMessage: true, errorTitle: "Работа", error: "Выберите работу из списка — он берётся с листа «График производства работ»." };
    for (const col of [7, 9])
      ws.getCell(r, col).dataValidation = { type: "whole", operator: "between", formulae: [0, 365], allowBlank: true, showErrorMessage: true, errorTitle: "Дни", error: "Целое число дней" };
  }
  const K = L(M0);
  const solid = (c: string) => ({ fill: { type: "pattern", pattern: "solid", bgColor: argb(c) } });
  ws.addConditionalFormatting({
    ref: `${K}6:${L(M0 + MDAYS - 1)}${MLAST}`,
    rules: [
      { type: "expression", priority: 1, stopIfTrue: true, formulae: [`AND(ISNUMBER($H6),${K}$5=$H6)`], style: solid("70AD47") },
      { type: "expression", priority: 2, stopIfTrue: true, formulae: [`AND(ISNUMBER($J6),${K}$5=$J6)`], style: solid("ED7D31") },
      { type: "expression", priority: 3, formulae: [`AND(ISNUMBER($J6),ISNUMBER($H6),${K}$5>$J6,${K}$5<$H6)`], style: solid("A9D08E") },
    ],
  });
  ws.addConditionalFormatting({ ref: `J6:J${MLAST}`, rules: [{ type: "expression", priority: 1, formulae: [`AND(ISNUMBER($J6),$J6<TODAY())`], style: { font: { color: argb("C00000"), bold: true } } }] });
  ws.addConditionalFormatting({ ref: `F6:F${MLAST}`, rules: [{ type: "expression", priority: 1, formulae: [`$F6="нет в ГПР"`], style: { font: { color: argb("C00000"), bold: true } } }] });
  ws.addConditionalFormatting({ ref: `${K}5:${L(M0 + MDAYS - 1)}5`, rules: [{ type: "expression", priority: 1, formulae: [`${K}$5=TODAY()`], style: solid("C00000") }] });
  const lg = MLAST + 2;
  ws.getCell(lg, 2).value = "Обозначения:";
  ws.getCell(lg, 2).font = font({ size: 8, bold: true });
  ([["ED7D31", "заказ (красная дата — заказ просрочен)"], ["A9D08E", "изготовление / доставка"], ["70AD47", "поставка на объект"]] as const).forEach(([c, txt], k) => {
    ws.getCell(lg + k, 3).fill = fill(c); ws.getCell(lg + k, 3).border = BT;
    ws.getCell(lg + k, 4).value = txt; ws.getCell(lg + k, 4).font = font({ size: 8 });
  });
}

const GUIDE: [string, "t" | "s" | "h" | ""][] = [
  ["Книга объекта — форма АТР-КО-01", "t"],
  [REV, "s"],
  ["", ""],
  ["Что это", "h"],
  ["Одна книга на объект: ведомость объёмов, коммерческая смета, ресурсы, график работ (ГПР) и график поставки материалов (ГПМ). Кто бы ни составлял расчёт — он переносит его в эту форму, и книга целиком загружается на сайт: «Объекты» → объект → «Книга объекта» → «Загрузить заполненную книгу».", ""],
  ["Что загружается на сайт", "h"],
  ["• «График производства работ» → вкладка «График работ»: работы, сроки, потоки (становятся разделами графика).", ""],
  ["• «Коммерческая смета» → вкладка «Сметы и бюджет»: каждая позиция — строка бюджета с планом (работы / материалы / техника отдельно). Факт потом вносится на сайте.", ""],
  ["• «График поставки материалов» → вкладка «Снабжение»: каждая строка — заявка с датой «нужно на объекте к» = дата поставки.", ""],
  ["• Ведомость объёмов и ведомость ресурсов на сайт не грузятся — это расчётные листы.", ""],
  ["Общие правила", "h"],
  ["• Жёлтые ячейки заполняются, белые и зелёные считаются сами. Названия листов и столбцов не менять — по ним книга читается сайтом.", ""],
  ["• Во второй строке каждого листа — объект, адрес, заказчик, договор.", ""],
  ["• Строки добавляйте вставкой ВНУТРИ таблицы (не ниже последней строки), чтобы формулы и итоги их захватили.", ""],
  ["График производства работ", "h"],
  ["• № — целое число 1, 2, 3 … без повторов. Это постоянный номер работы: по нему к работе привязывается смета, и по нему при повторной загрузке сайт находит ту же работу. Не перенумеровывать после первой загрузки — новые работы получают следующие номера.", ""],
  ["• Поток — из списка внизу листа (названия потоков можно переименовать под объект). Работы одного потока на сайте собираются в один раздел.", ""],
  ["• Дата начала и длительность в календарных днях. Окончание и полоса на шкале строятся сами.", ""],
  ["Коммерческая смета", "h"],
  ["• Раздел сверху, позиции под ним, «Итого по разделу» — снизу (не в строке заголовка). ПРЯМЫЕ ЗАТРАТЫ собираются со всех «Итого по разделу» сами.", ""],
  ["• Стоимости — СЕБЕСТОИМОСТЬ АТР по позиции: работы, материалы/оборудование, спецтехника — каждая в своём столбце.", ""],
  ["• № работы по ГПР — номер работы с листа ГПР, к которой относится позиция. Желательно для каждой позиции: тогда сайт сам посчитает стоимость работ в графике и экономию/перерасход по закрытым работам.", ""],
  ["• Накладные расходы и прибыль (%) на сайт не грузятся — это наценка до коммерческой стоимости.", ""],
  ["График поставки материалов", "h"],
  ["• Связанная работа — выбирается из списка (работы с листа ГПР). Дата начала работ подтянется сама; «нет в ГПР» — название не совпало.", ""],
  ["• Дн. до — за сколько дней до начала работы материал должен быть на объекте. Срок изг. — дней от заказа до поставки. Красная дата заказа — заказ уже просрочен.", ""],
  ["• Кол-во — число (можно «~10», сайт возьмёт 10).", ""],
  ["Повторная загрузка", "h"],
  ["• Работы ищутся по №, позиции сметы — по названию, заявки — по материалу и работе. Совпавшие обновляются, новые добавляются, ничего не удаляется. Факт затрат и заказанные заявки сайт не трогает.", ""],
];

function sheetGuide(wb: any) {
  const ws = wb.addWorksheet("Как заполнять");
  ws.getColumn(1).width = 115;
  GUIDE.forEach(([text, kind], i) => {
    const c = ws.getCell(i + 1, 1);
    c.value = text;
    c.alignment = { wrapText: true, vertical: "top" };
    c.font = font({
      size: kind === "t" ? 14 : kind === "h" ? 11 : 10,
      bold: kind === "t" || kind === "h",
      italic: kind === "s",
      color: kind === "t" ? TITLE : kind === "h" ? HEAD : kind === "s" ? "808080" : "000000",
    });
  });
}

/** Пустая книга объекта; objectLine — строка «объект, адрес, заказчик, договор» во второй строке листов. */
export async function buildWorkbookForm(ExcelJS: any, objectLine: string): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Стройплатформа АТР";
  wb.calcProperties = { fullCalcOnLoad: true };
  const sub = objectLine || "Объект, адрес, заказчик, договор";
  sheetVor(wb, sub);
  sheetSmeta(wb, sub);
  sheetResources(wb, sub);
  sheetGpr(wb, sub);
  sheetGpm(wb);
  sheetGuide(wb);
  for (const ws of wb.worksheets) {
    if (ws.name !== "Как заполнять") ws.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
  }
  return wb.xlsx.writeBuffer();
}

/** Собрать и скачать форму. Имя файла латиницей — иначе часть браузеров теряет расширение. */
export async function downloadWorkbookForm(objectLine: string, fileTag: string): Promise<void> {
  const ExcelJS = await loadExcelJs();
  const data = await buildWorkbookForm(ExcelJS, objectLine);
  const blob = new Blob([data], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `ATR-KO-01_${fileTag || "kniga"}.xlsx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

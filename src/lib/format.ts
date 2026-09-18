/** Общие форматтеры вывода. Единый формат чисел и дат во всех модулях. */

/** "2026-03-01" -> "01.03.2026". Пустое значение -> "—". */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const p = iso.split("-");
  if (p.length !== 3) return iso;
  return `${p[2]}.${p[1]}.${p[0]}`;
}

export function fmtMoney(n: number | string | null | undefined): string {
  if (n === undefined || n === null || n === "") return "—";
  const num = Number(n);
  if (isNaN(num)) return "—";
  return num.toLocaleString("ru-RU", { maximumFractionDigits: 0 }) + " ₽";
}

export function fmtDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

/** Число с разделителями разрядов; null/NaN -> "—". */
export function fmtNum(n: number | null | undefined, maxFrac = 1): string {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return "—";
  return Number(n).toLocaleString("ru-RU", { maximumFractionDigits: maxFrac });
}

/** Процент: 42.5 -> "42,5%". */
export function fmtPercent(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return "—";
  return fmtNum(n, 1) + "%";
}

/** Отклонение словами: «отстаёт на 12,3 пункта» — понятнее сухого «−12,3 п.п.». */
export function deviationWords(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return "нет данных для сравнения";
  const v = Number(n);
  if (Math.abs(v) < 0.05) return "идёт ровно по плану";
  const size = fmtNum(Math.abs(v), 1);
  const unit = plural(Math.abs(v), "пункт", "пункта", "пунктов");
  return v < 0
    ? `отстаёт от плана на ${size} ${unit}`
    : `опережает план на ${size} ${unit}`;
}

/** Отклонение со знаком: -12.3 -> "−12,3 п.п.". */
export function fmtDeviation(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return "—";
  const v = Number(n);
  const sign = v > 0 ? "+" : v < 0 ? "−" : "";
  return `${sign}${fmtNum(Math.abs(v), 1)} п.п.`;
}

/** Диапазон дат "01.03.2026–15.04.2026"; оба пустые -> "—". */
export function fmtRange(from: string | null, to: string | null): string {
  if (!from && !to) return "—";
  return `${fmtDate(from)}–${fmtDate(to)}`;
}

/**
 * Русское склонение после числа: plural(1, "этап", "этапа", "этапов") -> "этап".
 * Учитывает, что 11–14 ведут себя как «много», а не как 1–4.
 */
export function plural(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(Math.trunc(n));
  const mod100 = abs % 100;
  if (mod100 >= 11 && mod100 <= 14) return many;
  const mod10 = abs % 10;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

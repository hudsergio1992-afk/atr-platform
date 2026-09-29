import { SupplyRequest } from "@/lib/types";
import { parseDay } from "@/lib/schedule";

/** Показатели поставщика по заявкам, доехавшим до статуса «доставлено». */
export interface SupplierStats {
  delivered: number;
  onTime: number;
  /** % поставок в срок; null — доставленных заявок по поставщику ещё не было. */
  onTimePercent: number | null;
}

/**
 * Поставка «в срок», если факт получения не позже плановой даты доставки.
 * Без одной из дат судить нельзя — заявка просто не попадает в счёт.
 */
function isOnTime(r: SupplyRequest): boolean | null {
  const due = parseDay(r.delivery_due);
  const fact = parseDay(r.delivery_fact);
  if (due === null || fact === null) return null;
  return fact <= due;
}

/**
 * % поставок в срок по каждому поставщику — считается от заявок, а не
 * хранится: то же решение, что и для остальных производных показателей
 * платформы (график, приёмка). Ключ карты — supplier_id.
 */
export function computeSupplierStats(requests: SupplyRequest[]): Map<string, SupplierStats> {
  const out = new Map<string, SupplierStats>();
  requests
    .filter((r) => r.status === "delivered" && r.supplier_id)
    .forEach((r) => {
      const id = r.supplier_id as string;
      const cur = out.get(id) || { delivered: 0, onTime: 0, onTimePercent: null };
      cur.delivered++;
      const onTime = isOnTime(r);
      if (onTime) cur.onTime++;
      out.set(id, cur);
    });
  out.forEach((stats) => {
    stats.onTimePercent = stats.delivered > 0 ? Math.round((stats.onTime / stats.delivered) * 1000) / 10 : null;
  });
  return out;
}

/** Сводка по заявкам объекта для шапки модуля. */
export interface RequestsSummary {
  total: number;
  active: number;
  overdueDelivery: number;
  delivered: number;
}

export function summarizeRequests(requests: SupplyRequest[], today: string): RequestsSummary {
  let active = 0;
  let overdueDelivery = 0;
  let delivered = 0;
  const t = parseDay(today);
  requests.forEach((r) => {
    if (r.status === "cancelled") return;
    if (r.status === "delivered") {
      delivered++;
      return;
    }
    active++;
    const due = parseDay(r.delivery_due);
    if (t !== null && due !== null && t > due) overdueDelivery++;
  });
  return { total: requests.length, active, overdueDelivery, delivered };
}

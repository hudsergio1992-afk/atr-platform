export type ObjectType = "construction" | "design" | "reconstruction" | "equipment_install" | "supervision" | "commissioning";
export type ObjectStatus = "planning" | "active" | "paused" | "done";

export interface HistoryEntry {
  at: string;
  text: string;
}

export interface ConstructionObject {
  id: string;
  name: string;
  address: string;
  type: ObjectType;
  contract_number: string | null;
  contract_date: string | null;
  contract_amount: number | null;
  start_date: string | null;
  end_date_planned: string | null;
  status: ObjectStatus;
  history: HistoryEntry[];
  created_at: string;
  updated_at: string;
}

export const TYPE_LABEL: Record<ObjectType, string> = {
  construction: "Строительство",
  design: "Проектирование",
  reconstruction: "Реконструкция",
  equipment_install: "Монтаж оборудования",
  supervision: "Шеф-монтаж",
  commissioning: "Пусконаладка",
};

export const STATUS_LABEL: Record<ObjectStatus, string> = {
  planning: "Планирование",
  active: "В работе",
  paused: "Приостановлен",
  done: "Завершён",
};

export const STATUS_CLASS: Record<ObjectStatus, string> = {
  planning: "st-neutral",
  active: "st-good",
  paused: "st-warn",
  done: "st-neutral",
};

/* ---------- Модуль 2: График работ ---------- */

/** Авто-статус этапа: считается, а не хранится. */
export type ScheduleStatus = "on_track" | "behind" | "closed";

/**
 * Этап (работа) графика. Иерархия — через parent_id.
 * Длительность, % плана, отклонение и статус не хранятся в БД — они производные.
 */
export interface ScheduleTask {
  id: string;
  object_id: string;
  parent_id: string | null;
  sort_order: number;
  name: string;
  start_plan: string | null;
  end_plan: string | null;
  start_fact: string | null;
  end_fact: string | null;
  /** Нормочасы на работу. */
  norm_hours: number | null;
  /** % готовности факт — вводится вручную, 0…100. */
  progress_fact: number | null;
  history: HistoryEntry[];
  created_at: string;
  updated_at: string;
}

export const SCHEDULE_STATUS_LABEL: Record<ScheduleStatus, string> = {
  on_track: "В графике",
  behind: "ОТСТАВАНИЕ",
  closed: "Закрыт",
};

export const SCHEDULE_STATUS_CLASS: Record<ScheduleStatus, string> = {
  on_track: "st-good",
  behind: "st-bad",
  closed: "st-neutral",
};

export const MODULES = [
  { key: "objects", label: "Объекты", href: "/objects", ready: true },
  { key: "schedule", label: "График работ", href: "/schedule", ready: true },
  { key: "weekly", label: "Недельные задания", href: "#", ready: false },
  { key: "pto", label: "ПТО и ИД", href: "#", ready: false },
  { key: "supply", label: "Снабжение", href: "#", ready: false },
  { key: "budget", label: "Сметы и бюджет", href: "#", ready: false },
  { key: "control", label: "Контроль стройки", href: "#", ready: false },
  { key: "roles", label: "Роли и доступ", href: "#", ready: false },
] as const;

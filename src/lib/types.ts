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
  /** Общий натуральный объём работы: от него считаются недельные задания. */
  volume_total: number | null;
  /** Единица измерения объёма: м³, т, п.м и т. п. */
  unit: string | null;
  history: HistoryEntry[];
  created_at: string;
  updated_at: string;
}

/** Ходовые единицы измерения; поле остаётся свободным для ввода своей. */
export const UNITS = ["м³", "м²", "п.м", "т", "кг", "шт", "компл.", "к-т", "чел.-дн."] as const;

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

/* ---------- Модуль 3: Недельные задания (СНЗ) ---------- */

export type WeeklyStatus = "draft" | "issued" | "closed";

/** Задание на неделю по одному объекту. week_start — всегда понедельник. */
export interface WeeklyAssignment {
  id: string;
  object_id: string;
  week_start: string;
  status: WeeklyStatus;
  note: string | null;
  history: HistoryEntry[];
  created_at: string;
  updated_at: string;
}

/**
 * Строка задания. task_id необязателен: на стройке попадаются работы,
 * которых в графике нет, и терять их нельзя.
 */
export interface WeeklyItem {
  id: string;
  assignment_id: string;
  task_id: string | null;
  sort_order: number;
  name: string;
  unit: string | null;
  volume_plan: number | null;
  volume_fact: number | null;
  progress_plan: number | null;
  progress_fact: number | null;
  crew: string | null;
  note: string | null;
  history: HistoryEntry[];
  created_at: string;
  updated_at: string;
}

export const WEEKLY_STATUS_LABEL: Record<WeeklyStatus, string> = {
  draft: "Черновик",
  issued: "Выдано",
  closed: "Закрыто",
};

export const WEEKLY_STATUS_CLASS: Record<WeeklyStatus, string> = {
  draft: "st-neutral",
  issued: "st-warn",
  closed: "st-good",
};

export const MODULES = [
  { key: "objects", label: "Объекты", href: "/objects", ready: true },
  { key: "schedule", label: "График работ", href: "/schedule", ready: true },
  { key: "weekly", label: "Недельные задания", href: "/weekly", ready: true },
  { key: "pto", label: "ПТО и ИД", href: "#", ready: false },
  { key: "supply", label: "Снабжение", href: "#", ready: false },
  { key: "budget", label: "Сметы и бюджет", href: "#", ready: false },
  { key: "control", label: "Контроль стройки", href: "#", ready: false },
  { key: "roles", label: "Роли и доступ", href: "#", ready: false },
] as const;

export type ObjectType = "construction" | "design" | "reconstruction" | "equipment_install";
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

export const MODULES = [
  { key: "objects", label: "Объекты", href: "/objects", ready: true },
  { key: "schedule", label: "График работ", href: "#", ready: false },
  { key: "weekly", label: "Недельные задания", href: "#", ready: false },
  { key: "pto", label: "ПТО и ИД", href: "#", ready: false },
  { key: "supply", label: "Снабжение", href: "#", ready: false },
  { key: "budget", label: "Сметы и бюджет", href: "#", ready: false },
  { key: "control", label: "Контроль стройки", href: "#", ready: false },
  { key: "roles", label: "Роли и доступ", href: "#", ready: false },
] as const;

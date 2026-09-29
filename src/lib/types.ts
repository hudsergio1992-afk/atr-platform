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
 * Что выдавать по этапу в недельном задании.
 * volume — долю натурального объёма, приходящуюся на неделю (бетон, металл, сваи).
 * percent — цель в процентах без дробления объёма: силос один, а собирается месяц,
 * и выдавать «0,117 силоса на неделю» бессмысленно.
 *
 * На то, чем прораб отмечает выполнение, это не влияет: объём и процент
 * пересчитываются друг из друга везде, где у этапа задан общий объём.
 */
export type TrackingMode = "volume" | "percent";

/**
 * Откуда работа взялась. plan — была в первоначальном графике;
 * extra — вскрылась по ходу стройки: скрытые конструкции, предписание
 * надзора, переделка, допсоглашение. Различать их нужно, чтобы при разборе
 * сроков было видно, сколько времени ушло на то, чего в проекте не было.
 */
export type TaskKind = "plan" | "extra";

export const KIND_LABEL: Record<TaskKind, string> = {
  plan: "По графику",
  extra: "Непредвиденная",
};

export const TRACKING_LABEL: Record<TrackingMode, string> = {
  volume: "Объёмом на неделю",
  percent: "Процентом готовности",
};

/**
 * Этап (работа) графика. Иерархия — через parent_id.
 * Длительность, % плана, отклонение и статус не хранятся в БД — они производные.
 */
export interface ScheduleTask {
  id: string;
  object_id: string;
  parent_id: string | null;
  sort_order: number;
  /** Шифр из ГПР: «1», «1.1», «1.1.2». Задаёт иерархию при загрузке файлом. */
  code: string | null;
  name: string;
  start_plan: string | null;
  end_plan: string | null;
  start_fact: string | null;
  end_fact: string | null;
  /** % готовности факт — вводится вручную, 0…100. */
  progress_fact: number | null;
  /** Способ учёта выполнения: объёмом или процентом. */
  tracking: TrackingMode;
  /** По графику или непредвиденная. */
  kind: TaskKind;
  /** Основание непредвиденной работы: предписание, допсоглашение, вскрытые условия. */
  reason: string | null;
  /**
   * Общий натуральный объём работы. При учёте по объёму от него считаются
   * недельные задания и процент готовности; при учёте по проценту остаётся
   * справочной характеристикой («силос 1 шт») и в расчётах не участвует.
   */
  volume_total: number | null;
  /** Единица измерения объёма: м³, т, п.м и т. п. */
  unit: string | null;
  /**
   * Стоимость этапа целиком, в рублях. Единственная денежная величина, которая
   * хранится: цена за единицу и освоение — производные от неё и объёма.
   */
  cost_total: number | null;
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

/**
 * Работа, сохранённая в справочник самим прорабом. Типовые работы зашиты
 * в коде (src/lib/stages.ts) — эти дописываются к ним из базы.
 */
export interface CatalogStage {
  id: string;
  section: string;
  name: string;
  unit: string | null;
  tracking: TrackingMode;
  created_at: string;
}

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

/* ---------- Модуль 4 (минимум): Приёмка этапов ---------- */

/** draft — черновик, review — на согласовании, signed — подписан заказчиком. */
export type AcceptanceStatus = "draft" | "review" | "signed";

/** Акт приёмки (акт скрытых работ) одного этапа графика. */
export interface AcceptanceAct {
  id: string;
  task_id: string;
  object_id: string;
  status: AcceptanceStatus;
  act_number: string | null;
  act_date: string | null;
  amount: number | null;
  /** Что выполнено — содержательная часть акта скрытых работ. */
  description: string | null;
  /** Ответственный со стороны подрядчика, подписывающий акт. */
  responsible: string | null;
  history: HistoryEntry[];
  created_at: string;
  updated_at: string;
}

export const ACCEPTANCE_STATUS_LABEL: Record<AcceptanceStatus, string> = {
  draft: "Черновик",
  review: "На согласовании",
  signed: "Подписан",
};

export const ACCEPTANCE_STATUS_CLASS: Record<AcceptanceStatus, string> = {
  draft: "st-neutral",
  review: "st-warn",
  signed: "st-good",
};

/* ---------- Модуль 4: ПТО и ИД ---------- */

/** Запись журнала работ по объекту за дату; этап графика — необязательная привязка. */
export interface WorkLogEntry {
  id: string;
  object_id: string;
  task_id: string | null;
  entry_date: string;
  weather: string | null;
  crew: string | null;
  content: string;
  history: HistoryEntry[];
  created_at: string;
  updated_at: string;
}

export type CertDocType = "certificate" | "passport" | "other";

export const CERT_DOC_TYPE_LABEL: Record<CertDocType, string> = {
  certificate: "Сертификат",
  passport: "Паспорт",
  other: "Иной документ",
};

/** Запись реестра сертификатов и паспортов на материалы. */
export interface MaterialCertificate {
  id: string;
  object_id: string;
  material_name: string;
  doc_type: CertDocType;
  doc_number: string | null;
  doc_date: string | null;
  supplier: string | null;
  /** Привязка к поставке из модуля «Снабжение»; пока модуля нет — всегда null. */
  delivery_id: string | null;
  history: HistoryEntry[];
  created_at: string;
  updated_at: string;
}

/* ---------- Модуль 5: Снабжение ---------- */

export type SupplyStatus = "draft" | "pricing" | "approved" | "ordered" | "delivered" | "cancelled";

export const SUPPLY_STATUS_LABEL: Record<SupplyStatus, string> = {
  draft: "Заявка",
  pricing: "Сбор предложений",
  approved: "Согласовано",
  ordered: "Заказано",
  delivered: "Доставлено",
  cancelled: "Отменено",
};

export const SUPPLY_STATUS_CLASS: Record<SupplyStatus, string> = {
  draft: "st-neutral",
  pricing: "st-warn",
  approved: "st-warn",
  ordered: "st-warn",
  delivered: "st-good",
  cancelled: "st-bad",
};

/** Поставщик из общей базы. «% поставок в срок» — производный, не хранится. */
export interface Supplier {
  id: string;
  name: string;
  contact_person: string | null;
  phone: string | null;
  email: string | null;
  /** Субъективная оценка снабженца, 0…5. */
  rating: number | null;
  payment_terms: string | null;
  note: string | null;
  history: HistoryEntry[];
  created_at: string;
  updated_at: string;
}

/**
 * Заявка на материал — один жизненный цикл: заявка → сбор предложений →
 * согласование → заказ → доставка. supplier_id и поля заказа/доставки
 * заполняются по мере продвижения статуса.
 */
export interface SupplyRequest {
  id: string;
  object_id: string;
  task_id: string | null;
  material_name: string;
  quantity: number | null;
  unit: string | null;
  needed_by: string | null;
  status: SupplyStatus;
  supplier_id: string | null;
  order_amount: number | null;
  order_date: string | null;
  delivery_due: string | null;
  delivery_fact: string | null;
  note: string | null;
  history: HistoryEntry[];
  created_at: string;
  updated_at: string;
}

/**
 * Предложение (цена) от поставщика по заявке. supplier_id необязателен —
 * цену часто присылают от контакта, которого в справочнике ещё нет.
 */
export interface SupplyOffer {
  id: string;
  request_id: string;
  supplier_id: string | null;
  supplier_name: string | null;
  price: number | null;
  note: string | null;
  history: HistoryEntry[];
  created_at: string;
  updated_at: string;
}

export const MODULES = [
  { key: "dashboard", label: "Дашборд", href: "/dashboard", ready: true },
  { key: "objects", label: "Объекты", href: "/objects", ready: true },
  { key: "schedule", label: "График работ", href: "/schedule", ready: true },
  { key: "weekly", label: "Недельные задания", href: "/weekly", ready: true },
  { key: "pto", label: "ПТО и ИД", href: "/pto", ready: true },
  { key: "supply", label: "Снабжение", href: "/supply", ready: true },
  { key: "budget", label: "Сметы и бюджет", href: "#", ready: false },
  { key: "control", label: "Контроль стройки", href: "#", ready: false },
  { key: "roles", label: "Роли и доступ", href: "#", ready: false },
] as const;

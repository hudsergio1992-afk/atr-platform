-- Схема БД «Стройплатформы АТР» для Supabase (SQL Editor).
-- Скрипт идемпотентен: повторный запуск ничего не ломает.

-- Генератор идентификаторов. В свежих проектах Supabase есть по умолчанию,
-- в старых — нет, и без него создание таблиц падает на первой же строке.
create extension if not exists pgcrypto;

-- ── Модуль 1: Объекты ────────────────────────────────────────────────────────
create table if not exists public.objects (
  id                uuid primary key default gen_random_uuid(),
  name              text        not null,
  address           text        not null default '',
  type              text        not null default 'construction',
  contract_number   text,
  contract_date     date,
  contract_amount   numeric(14, 2),
  start_date        date,
  end_date_planned  date,
  status            text        not null default 'planning',
  history           jsonb       not null default '[]'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- ── Модуль 2: График работ ───────────────────────────────────────────────────
create table if not exists public.schedule_tasks (
  id            uuid primary key default gen_random_uuid(),
  object_id     uuid        not null references public.objects (id) on delete cascade,
  parent_id     uuid        references public.schedule_tasks (id) on delete cascade,
  sort_order    integer     not null default 0,
  code          text,
  name          text        not null,
  start_plan    date,
  end_plan      date,
  start_fact    date,
  end_fact      date,
  progress_fact numeric(5, 2)  not null default 0
                check (progress_fact >= 0 and progress_fact <= 100),
  tracking      text        not null default 'percent'
                check (tracking in ('volume', 'percent')),
  kind          text        not null default 'plan'
                check (kind in ('plan', 'extra')),
  reason        text,
  volume_total  numeric(14, 3) check (volume_total is null or volume_total >= 0),
  unit          text,
  cost_total    numeric(14, 2) check (cost_total is null or cost_total >= 0),
  history       jsonb       not null default '[]'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table public.schedule_tasks add column if not exists volume_total numeric(14, 3);
alter table public.schedule_tasks add column if not exists unit text;
alter table public.schedule_tasks add column if not exists cost_total numeric(14, 2);
alter table public.schedule_tasks drop column if exists norm_hours;
alter table public.schedule_tasks
  add column if not exists tracking text not null default 'percent';
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'schedule_tasks_tracking_check'
  ) then
    alter table public.schedule_tasks
      add constraint schedule_tasks_tracking_check check (tracking in ('volume', 'percent'));
  end if;
end $$;
update public.schedule_tasks set tracking = 'volume'
  where volume_total is not null and volume_total > 0 and tracking = 'percent';

alter table public.schedule_tasks
  add column if not exists kind text not null default 'plan';
alter table public.schedule_tasks add column if not exists reason text;
alter table public.schedule_tasks add column if not exists code text;
create unique index if not exists schedule_tasks_code_idx
  on public.schedule_tasks (object_id, code) where code is not null;
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'schedule_tasks_kind_check'
  ) then
    alter table public.schedule_tasks
      add constraint schedule_tasks_kind_check check (kind in ('plan', 'extra'));
  end if;
end $$;

create index if not exists schedule_tasks_object_idx on public.schedule_tasks (object_id, sort_order);
create index if not exists schedule_tasks_parent_idx on public.schedule_tasks (parent_id);

-- ── Свой справочник работ ────────────────────────────────────────────────────
create table if not exists public.stage_catalog (
  id         uuid primary key default gen_random_uuid(),
  section    text        not null,
  name       text        not null,
  unit       text,
  tracking   text        not null default 'percent'
             check (tracking in ('volume', 'percent')),
  created_at timestamptz not null default now()
);

create unique index if not exists stage_catalog_name_idx
  on public.stage_catalog (lower(section), lower(name));

-- ── Модуль 3: Недельные задания (СНЗ) ────────────────────────────────────────
create table if not exists public.weekly_assignments (
  id         uuid primary key default gen_random_uuid(),
  object_id  uuid        not null references public.objects (id) on delete cascade,
  week_start date        not null,
  status     text        not null default 'draft',
  note       text,
  history    jsonb       not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (object_id, week_start)
);

create table if not exists public.weekly_items (
  id            uuid primary key default gen_random_uuid(),
  assignment_id uuid        not null references public.weekly_assignments (id) on delete cascade,
  task_id       uuid        references public.schedule_tasks (id) on delete set null,
  sort_order    integer     not null default 0,
  name          text        not null,
  unit          text,
  volume_plan   numeric(14, 3) check (volume_plan is null or volume_plan >= 0),
  volume_fact   numeric(14, 3) check (volume_fact is null or volume_fact >= 0),
  progress_plan numeric(5, 2)  check (progress_plan is null or (progress_plan >= 0 and progress_plan <= 100)),
  progress_fact numeric(5, 2)  check (progress_fact is null or (progress_fact >= 0 and progress_fact <= 100)),
  crew          text,
  note          text,
  history       jsonb       not null default '[]'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists weekly_assignments_object_idx on public.weekly_assignments (object_id, week_start desc);
create index if not exists weekly_items_assignment_idx on public.weekly_items (assignment_id, sort_order);
create index if not exists weekly_items_task_idx on public.weekly_items (task_id);

update public.weekly_items wi set task_id = null
where wi.task_id is not null
  and exists (
    select 1 from public.weekly_items other
    where other.assignment_id = wi.assignment_id
      and other.task_id = wi.task_id
      and (other.updated_at, other.id) > (wi.updated_at, wi.id)
  );

create unique index if not exists weekly_items_one_row_per_task
  on public.weekly_items (assignment_id, task_id)
  where task_id is not null;

-- ── Модуль 4 (минимум): Приёмка этапов ───────────────────────────────────────
create table if not exists public.acceptance_acts (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid        not null references public.schedule_tasks (id) on delete cascade,
  object_id   uuid        not null references public.objects (id) on delete cascade,
  status      text        not null default 'draft'
              check (status in ('draft', 'review', 'signed')),
  act_number  text,
  act_date    date,
  amount      numeric(14, 2) check (amount is null or amount >= 0),
  history     jsonb       not null default '[]'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index if not exists acceptance_acts_task_idx on public.acceptance_acts (task_id);
create index if not exists acceptance_acts_object_idx on public.acceptance_acts (object_id, status);

-- ── Модуль 4: ПТО и исполнительная документация ─────────────────────────────
alter table public.acceptance_acts add column if not exists description text;
alter table public.acceptance_acts add column if not exists responsible text;

create table if not exists public.work_log_entries (
  id         uuid primary key default gen_random_uuid(),
  object_id  uuid        not null references public.objects (id) on delete cascade,
  task_id    uuid        references public.schedule_tasks (id) on delete set null,
  entry_date date        not null,
  weather    text,
  crew       text,
  content    text        not null,
  history    jsonb       not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists work_log_entries_object_idx on public.work_log_entries (object_id, entry_date desc);
create index if not exists work_log_entries_task_idx on public.work_log_entries (task_id);

create table if not exists public.material_certificates (
  id            uuid primary key default gen_random_uuid(),
  object_id     uuid        not null references public.objects (id) on delete cascade,
  material_name text        not null,
  doc_type      text        not null default 'certificate'
                check (doc_type in ('certificate', 'passport', 'other')),
  doc_number    text,
  doc_date      date,
  supplier      text,
  delivery_id   uuid,
  history       jsonb       not null default '[]'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists material_certificates_object_idx on public.material_certificates (object_id);
create index if not exists material_certificates_delivery_idx on public.material_certificates (delivery_id);

-- ── Модуль 5: Снабжение ──────────────────────────────────────────────────────
-- База поставщиков. «% поставок в срок» не хранится — считается из
-- supply_requests (доставлено ли к сроку), как и остальные производные
-- показатели платформы.
create table if not exists public.suppliers (
  id             uuid primary key default gen_random_uuid(),
  name           text        not null,
  contact_person text,
  phone          text,
  email          text,
  -- Рейтинг — субъективная оценка снабженца, 0…5, не считается.
  rating         numeric(2, 1) check (rating is null or (rating >= 0 and rating <= 5)),
  payment_terms  text,
  note           text,
  history        jsonb       not null default '[]'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Заявка на материал: наименование → сбор предложений → согласование → заказ → доставка.
-- Один жизненный цикл — одна запись, статус переходит по цепочке; supplier_id и
-- поля заказа/доставки заполняются по ходу продвижения заявки.
create table if not exists public.supply_requests (
  id            uuid primary key default gen_random_uuid(),
  object_id     uuid        not null references public.objects (id) on delete cascade,
  task_id       uuid        references public.schedule_tasks (id) on delete set null,
  material_name text        not null,
  quantity      numeric(14, 3) check (quantity is null or quantity >= 0),
  unit          text,
  needed_by     date,
  status        text        not null default 'draft'
                check (status in ('draft', 'pricing', 'approved', 'ordered', 'delivered', 'cancelled')),
  -- Выбранный поставщик и условия заказа — заполняются на этапе «Заказ».
  supplier_id   uuid        references public.suppliers (id) on delete set null,
  order_amount  numeric(14, 2) check (order_amount is null or order_amount >= 0),
  order_date    date,
  delivery_due  date,
  delivery_fact date,
  note          text,
  history       jsonb       not null default '[]'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists supply_requests_object_idx on public.supply_requests (object_id, status);
create index if not exists supply_requests_supplier_idx on public.supply_requests (supplier_id);
create index if not exists supply_requests_task_idx on public.supply_requests (task_id);

-- Предложения (цены) от поставщиков по заявке. supplier_id необязателен — цену
-- часто присылают от контакта, которого в справочнике поставщиков ещё нет,
-- и здесь остаётся его имя текстом, а не потерянная строка.
create table if not exists public.supply_offers (
  id            uuid primary key default gen_random_uuid(),
  request_id    uuid        not null references public.supply_requests (id) on delete cascade,
  supplier_id   uuid        references public.suppliers (id) on delete set null,
  supplier_name text,
  price         numeric(14, 2) check (price is null or price >= 0),
  note          text,
  history       jsonb       not null default '[]'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists supply_offers_request_idx on public.supply_offers (request_id);

-- Реестр сертификатов (модуль 4) теперь может ссылаться на заявку снабжения,
-- по которой материал приехал — таблица supply_requests существует только
-- с этого места файла, поэтому внешний ключ добавляется отдельным шагом.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'material_certificates_delivery_fkey'
  ) then
    alter table public.material_certificates
      add constraint material_certificates_delivery_fkey
      foreign key (delivery_id) references public.supply_requests (id) on delete set null;
  end if;
end $$;

-- ── Доступ ───────────────────────────────────────────────────────────────────
alter table public.objects            enable row level security;
alter table public.schedule_tasks     enable row level security;
alter table public.weekly_assignments enable row level security;
alter table public.weekly_items       enable row level security;
alter table public.stage_catalog      enable row level security;
alter table public.acceptance_acts    enable row level security;
alter table public.work_log_entries       enable row level security;
alter table public.material_certificates  enable row level security;
alter table public.suppliers        enable row level security;
alter table public.supply_requests  enable row level security;
alter table public.supply_offers    enable row level security;

drop policy if exists objects_anon_all on public.objects;
create policy objects_anon_all on public.objects
  for all to anon, authenticated using (true) with check (true);

drop policy if exists schedule_tasks_anon_all on public.schedule_tasks;
create policy schedule_tasks_anon_all on public.schedule_tasks
  for all to anon, authenticated using (true) with check (true);

drop policy if exists weekly_assignments_anon_all on public.weekly_assignments;
create policy weekly_assignments_anon_all on public.weekly_assignments
  for all to anon, authenticated using (true) with check (true);

drop policy if exists weekly_items_anon_all on public.weekly_items;
create policy weekly_items_anon_all on public.weekly_items
  for all to anon, authenticated using (true) with check (true);

drop policy if exists stage_catalog_anon_all on public.stage_catalog;
create policy stage_catalog_anon_all on public.stage_catalog
  for all to anon, authenticated using (true) with check (true);

drop policy if exists acceptance_acts_anon_all on public.acceptance_acts;
create policy acceptance_acts_anon_all on public.acceptance_acts
  for all to anon, authenticated using (true) with check (true);

drop policy if exists work_log_entries_anon_all on public.work_log_entries;
create policy work_log_entries_anon_all on public.work_log_entries
  for all to anon, authenticated using (true) with check (true);

drop policy if exists material_certificates_anon_all on public.material_certificates;
create policy material_certificates_anon_all on public.material_certificates
  for all to anon, authenticated using (true) with check (true);

drop policy if exists suppliers_anon_all on public.suppliers;
create policy suppliers_anon_all on public.suppliers
  for all to anon, authenticated using (true) with check (true);

drop policy if exists supply_requests_anon_all on public.supply_requests;
create policy supply_requests_anon_all on public.supply_requests
  for all to anon, authenticated using (true) with check (true);

drop policy if exists supply_offers_anon_all on public.supply_offers;
create policy supply_offers_anon_all on public.supply_offers
  for all to anon, authenticated using (true) with check (true);

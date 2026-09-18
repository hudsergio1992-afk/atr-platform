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
-- Иерархия этапов — через parent_id. Длительность, % плана, отклонение и статус
-- НЕ хранятся: это производные, считаются в src/lib/schedule.ts.
create table if not exists public.schedule_tasks (
  id            uuid primary key default gen_random_uuid(),
  object_id     uuid        not null references public.objects (id) on delete cascade,
  parent_id     uuid        references public.schedule_tasks (id) on delete cascade,
  sort_order    integer     not null default 0,
  name          text        not null,
  start_plan    date,
  end_plan      date,
  start_fact    date,
  end_fact      date,
  progress_fact numeric(5, 2)  not null default 0
                check (progress_fact >= 0 and progress_fact <= 100),
  -- Способ учёта выполнения: 'volume' — набранным натуральным объёмом,
  -- 'percent' — процентом готовности (штучные, но длительные работы: сборка
  -- силоса, монтаж нории, пусконаладка).
  tracking      text        not null default 'percent'
                check (tracking in ('volume', 'percent')),
  -- Откуда работа взялась: 'plan' — была в первоначальном графике,
  -- 'extra' — вскрылась по ходу стройки (предписание, допсоглашение, переделка).
  kind          text        not null default 'plan'
                check (kind in ('plan', 'extra')),
  -- Основание непредвиденной работы.
  reason        text,
  -- Натуральный объём работы и его единица измерения: от них считаются
  -- недельные задания (модуль «Недельные задания»).
  volume_total  numeric(14, 3) check (volume_total is null or volume_total >= 0),
  unit          text,
  history       jsonb       not null default '[]'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Для баз, созданных до появления натуральных объёмов.
alter table public.schedule_tasks add column if not exists volume_total numeric(14, 3);
alter table public.schedule_tasks add column if not exists unit text;
-- Нормочасы из платформы убраны: трудозатраты здесь не ведутся.
alter table public.schedule_tasks drop column if exists norm_hours;
-- Способ учёта выполнения. Этапы, заведённые до его появления, считаются
-- учитываемыми по объёму, если объём у них был указан.
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

-- Признак непредвиденной работы и её основание.
alter table public.schedule_tasks
  add column if not exists kind text not null default 'plan';
alter table public.schedule_tasks add column if not exists reason text;
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

-- ── Модуль 3: Недельные задания (СНЗ) ────────────────────────────────────────
-- Задание — это неделя по одному объекту. week_start всегда понедельник.
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

-- Строка задания. task_id необязателен: на стройке попадаются работы,
-- которых в графике нет, и терять их нельзя.
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

-- Одна работа графика — одна строка в задании недели. Две строки по одному этапу
-- означали бы два разных факта по одной работе, и было бы неясно, какой верен.
-- Если дубли успели появиться, лишним строкам снимается привязка к этапу:
-- сами строки остаются (труд прораба не теряется), но становятся работами вне графика.
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

-- ── Доступ ───────────────────────────────────────────────────────────────────
-- MVP работает без аутентификации: анонимный ключ имеет полный доступ.
-- Заменить на политики по ролям в модуле 8 «Роли и доступ».
alter table public.objects            enable row level security;
alter table public.schedule_tasks     enable row level security;
alter table public.weekly_assignments enable row level security;
alter table public.weekly_items       enable row level security;

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

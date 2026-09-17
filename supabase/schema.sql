-- Схема БД «Стройплатформы АТР» для Supabase (SQL Editor).
-- Скрипт идемпотентен: повторный запуск ничего не ломает.

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
  norm_hours    numeric(12, 2) check (norm_hours is null or norm_hours >= 0),
  progress_fact numeric(5, 2)  not null default 0
                check (progress_fact >= 0 and progress_fact <= 100),
  history       jsonb       not null default '[]'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists schedule_tasks_object_idx on public.schedule_tasks (object_id, sort_order);
create index if not exists schedule_tasks_parent_idx on public.schedule_tasks (parent_id);

-- ── Доступ ───────────────────────────────────────────────────────────────────
-- MVP работает без аутентификации: анонимный ключ имеет полный доступ.
-- Заменить на политики по ролям в модуле 8 «Роли и доступ».
alter table public.objects        enable row level security;
alter table public.schedule_tasks enable row level security;

drop policy if exists objects_anon_all on public.objects;
create policy objects_anon_all on public.objects
  for all to anon, authenticated using (true) with check (true);

drop policy if exists schedule_tasks_anon_all on public.schedule_tasks;
create policy schedule_tasks_anon_all on public.schedule_tasks
  for all to anon, authenticated using (true) with check (true);

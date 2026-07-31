-- 0001_init.sql
-- Amazon P&L Calculator: base schema + RLS
-- Принцип: default deny. RLS включён на всех таблицах.
-- Расчётные справочники недоступны клиенту (читает только service_role).
--
-- Защита строится в два слоя, потому что одного мало:
--   1) RLS — режет строки;
--   2) явные REVOKE — режет доступ к таблице на уровне привилегий, чтобы
--      случайно добавленная в будущем политика не открыла таблицу целиком.
-- Supabase по умолчанию выдаёт anon/authenticated широкие гранты на новые
-- таблицы в public, поэтому REVOKE обязателен, а не «на всякий случай».

create extension if not exists pgcrypto;
create extension if not exists btree_gist;

-- ---------------------------------------------------------------------------
-- profiles: зеркало auth.users
-- ---------------------------------------------------------------------------
create table public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  email      text not null,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy profiles_select_own on public.profiles
  for select to authenticated using (id = (select auth.uid()));

-- INSERT/UPDATE/DELETE политик нет: строки создаёт триггер (security definer).
revoke insert, update, delete on public.profiles from anon, authenticated;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, coalesce(new.email, ''))
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- licenses: доступ к расчётам. Создание/изменение — только service_role.
-- ---------------------------------------------------------------------------
create type public.license_status as enum ('active', 'suspended', 'revoked');

create table public.licenses (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  starts_at  timestamptz not null default now(),
  expires_at timestamptz not null,
  status     public.license_status not null default 'active',
  source     text not null default 'manual',  -- manual | stripe | robokassa
  note       text,
  created_at timestamptz not null default now(),
  constraint licenses_dates_chk check (expires_at > starts_at)
);

create index licenses_user_active_idx
  on public.licenses (user_id, expires_at desc)
  where status = 'active';

alter table public.licenses enable row level security;

-- Пользователь видит свои лицензии (для экрана "лицензия до ...").
create policy licenses_select_own on public.licenses
  for select to authenticated using (user_id = (select auth.uid()));
-- Никаких insert/update/delete политик: только service_role (обходит RLS).
revoke insert, update, delete on public.licenses from anon, authenticated;

-- ---------------------------------------------------------------------------
-- projects: пользовательские сценарии расчёта
-- ---------------------------------------------------------------------------
create table public.projects (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 200),
  inputs     jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Клиент пишет сюда напрямую через PostgREST: ограничиваем размер, иначе
  -- строка проекта — это неограниченное файловое хранилище на аккаунте
  -- заказчика.
  constraint projects_inputs_size_chk check (pg_column_size(inputs) <= 65536)
);

create index projects_user_idx on public.projects (user_id, updated_at desc);

alter table public.projects enable row level security;

create policy projects_select_own on public.projects
  for select to authenticated using (user_id = (select auth.uid()));
create policy projects_insert_own on public.projects
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy projects_update_own on public.projects
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy projects_delete_own on public.projects
  for delete to authenticated using (user_id = (select auth.uid()));

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger projects_touch before update on public.projects
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- calculations: журнал расчётов (пишет только Edge Function через service_role)
-- ---------------------------------------------------------------------------
create table public.calculations (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references public.projects (id) on delete cascade,
  user_id        uuid not null references public.profiles (id) on delete cascade,
  inputs         jsonb not null,
  results        jsonb not null,
  engine_version text not null,
  created_at     timestamptz not null default now()
);

create index calculations_project_idx on public.calculations (project_id, created_at desc);
create index calculations_user_created_idx on public.calculations (user_id, created_at desc);

alter table public.calculations enable row level security;

-- Читать свою историю можно; писать — только service_role (расчёт делает сервер).
create policy calculations_select_own on public.calculations
  for select to authenticated using (user_id = (select auth.uid()));
revoke insert, update, delete on public.calculations from anon, authenticated;

-- ---------------------------------------------------------------------------
-- commission_rates: справочники комиссий Amazon.
-- КЛИЕНТУ НЕДОСТУПНЫ: RLS включён, политик для authenticated/anon нет вообще,
-- плюс сняты табличные гранты.
-- Читает только Edge Function (service_role). Обновляет заказчик через SQL.
-- ---------------------------------------------------------------------------
create table public.commission_rates (
  id          uuid primary key default gen_random_uuid(),
  category    text not null,
  rate        numeric(6,4) not null check (rate >= 0 and rate <= 1),
  fixed_fee   numeric(10,2) not null default 0,
  valid_from  date not null default current_date,
  valid_to    date,
  constraint commission_valid_chk check (valid_to is null or valid_to > valid_from)
);

create unique index commission_rates_cat_from_uq
  on public.commission_rates (category, valid_from);

-- Периоды действия одной категории не должны пересекаться: иначе запрос
-- "ставка на сегодня" отдаёт произвольную из двух и расчёт становится
-- недетерминированным.
alter table public.commission_rates
  add constraint commission_rates_no_overlap
  exclude using gist (
    category with =,
    daterange(valid_from, valid_to, '[)') with &&
  );

alter table public.commission_rates enable row level security;
-- Политик нет намеренно: default deny для всех ролей кроме service_role.
revoke all on public.commission_rates from anon, authenticated;

-- ---------------------------------------------------------------------------
-- audit_log
-- ---------------------------------------------------------------------------
create table public.audit_log (
  id         bigint generated always as identity primary key,
  user_id    uuid,
  action     text not null,
  meta       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index audit_log_user_idx on public.audit_log (user_id, created_at desc);
create index audit_log_action_idx on public.audit_log (action, created_at desc);

alter table public.audit_log enable row level security;
-- Политик нет: пишет/читает только service_role.
revoke all on public.audit_log from anon, authenticated;

-- ---------------------------------------------------------------------------
-- rate_limits: простой fixed-window лимитер для функции calculate
-- ---------------------------------------------------------------------------
create table public.rate_limits (
  user_id      uuid not null,
  window_start timestamptz not null,
  cnt          integer not null default 0,
  primary key (user_id, window_start)
);

alter table public.rate_limits enable row level security;
-- Политик нет: только service_role.
revoke all on public.rate_limits from anon, authenticated;

-- Удаление окон старше суток. Единственное место, где задана политика
-- хранения: bump_rate_limit вызывает эту функцию, отдельно её может дёргать
-- pg_cron.
create or replace function public.cleanup_rate_limits()
returns void language sql security definer set search_path = public, pg_temp as $$
  delete from public.rate_limits where window_start < now() - interval '1 day';
$$;
revoke execute on function public.cleanup_rate_limits() from public, anon, authenticated;
grant execute on function public.cleanup_rate_limits() to service_role;

-- Атомарный инкремент; возвращает текущее значение счётчика в окне.
create or replace function public.bump_rate_limit(
  p_user_id uuid,
  p_window_seconds integer default 60
)
returns integer
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  v_window timestamptz;
  v_cnt integer;
begin
  if p_window_seconds is null or p_window_seconds <= 0 then
    raise exception 'p_window_seconds must be positive';
  end if;
  v_window := to_timestamp(
    floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds
  );
  insert into public.rate_limits as rl (user_id, window_start, cnt)
  values (p_user_id, v_window, 1)
  on conflict (user_id, window_start)
  do update set cnt = rl.cnt + 1
  returning cnt into v_cnt;
  -- лениво чистим старые окна (~1% вызовов)
  if random() < 0.01 then
    perform public.cleanup_rate_limits();
  end if;
  return v_cnt;
end;
$$;

-- Функция вызывается только с service_role: отзываем у остальных и даём явный
-- grant (revoke from public снимает default-грант, включая service_role).
revoke execute on function public.bump_rate_limit(uuid, integer) from public, anon, authenticated;
grant execute on function public.bump_rate_limit(uuid, integer) to service_role;

-- ---------------------------------------------------------------------------
-- Хелпер: активная лицензия (используется Edge Function'ом; SQL-истина одна)
-- ---------------------------------------------------------------------------
create or replace function public.has_active_license(p_user_id uuid)
returns boolean
language sql
stable
security definer set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.licenses
    where user_id = p_user_id
      and status = 'active'
      and starts_at <= now()
      and expires_at > now()
  );
$$;

revoke execute on function public.has_active_license(uuid) from public, anon, authenticated;
grant execute on function public.has_active_license(uuid) to service_role;

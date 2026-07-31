-- ТОЛЬКО ДЛЯ ТЕСТОВ. На проекте Supabase эти объекты уже существуют и эта
-- миграция не применяется (лежит вне supabase/migrations намеренно).
--
-- Воспроизводит ту часть окружения Supabase, от которой зависит схема:
-- роли, схему auth и auth.uid(). Включая широкие гранты по умолчанию —
-- именно от них защищают REVOKE в 0001, поэтому без них тест был бы
-- бессмысленно зелёным.

-- Роли в Postgres общие на кластер, а не на базу: создаём идемпотентно, иначе
-- повторный локальный прогон падает на остатках предыдущего.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin;
  end if;
end;
$$;

-- service_role в Supabase обходит RLS — от этого зависит смысл тестов.
alter role service_role bypassrls;
alter role anon nobypassrls;
alter role authenticated nobypassrls;

create schema auth;

create table auth.users (
  id    uuid primary key,
  email text
);

create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on tables to anon, authenticated, service_role;

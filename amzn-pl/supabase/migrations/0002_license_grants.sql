-- 0002_license_grants.sql
--
-- ШОВ ДЛЯ ВЫДАЧИ ЛИЦЕНЗИЙ. Не интеграция со Stripe/Robokassa: здесь нет ни
-- ключей, ни webhook-эндпоинта, ни SDK. Это одна идемпотентная функция, к
-- которой позже подключается любой провайдер (или продолжает работать ручная
-- выдача из SQL-редактора).
--
-- Зачем это в базовой инфраструктуре, если платежи вне скоупа: идемпотентность
-- — единственная часть, которую больно добавлять задним числом. Провайдер
-- повторяет webhook при таймауте, и без ключа идемпотентности повтор выдаёт
-- вторую лицензию на тот же платёж. Ретрофит этого на живых данных означает
-- разбор уже задвоенных лицензий вручную.
--
-- Если заказчик подтвердит, что выдача лицензий остаётся полностью ручной,
-- миграция удаляется целиком, ничего за собой не потянув.

-- Журнал обработанных платежей: ключ идемпотентности.
create table public.license_grants (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles (id) on delete cascade,
  license_id  uuid not null references public.licenses (id) on delete cascade,
  source      text not null,              -- manual | stripe | robokassa
  external_id text not null,              -- id платежа у провайдера
  days        integer not null check (days > 0),
  created_at  timestamptz not null default now()
);

-- Один платёж провайдера = максимум одна выдача.
create unique index license_grants_source_external_uq
  on public.license_grants (source, external_id);

alter table public.license_grants enable row level security;
-- Политик нет: пишет и читает только service_role.
revoke all on public.license_grants from anon, authenticated;

-- ---------------------------------------------------------------------------
-- grant_license: выдать/продлить лицензию, ровно один раз на external_id.
--
-- Продление, а не перезапись: если лицензия ещё активна, новый срок считается
-- от её expires_at, иначе от now(). Иначе оплата за месяц вперёд сжигала бы
-- остаток текущей.
--
-- Повторный вызов с тем же (source, external_id) не создаёт вторую лицензию и
-- возвращает id уже выданной.
-- ---------------------------------------------------------------------------
create or replace function public.grant_license(
  p_user_id     uuid,
  p_days        integer,
  p_source      text default 'manual',
  p_external_id text default null,
  p_note        text default null
)
returns uuid
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  v_external  text;
  v_existing  uuid;
  v_starts    timestamptz;
  v_license   uuid;
begin
  if p_days is null or p_days <= 0 then
    raise exception 'p_days must be positive';
  end if;
  if p_user_id is null then
    raise exception 'p_user_id is required';
  end if;

  -- Ручная выдача без внешнего id всё равно должна быть уникальной строкой в
  -- журнале, поэтому подставляем сгенерированный ключ.
  v_external := coalesce(p_external_id, 'manual:' || gen_random_uuid()::text);

  -- Уже обработан этот платёж?
  select license_id into v_existing
  from public.license_grants
  where source = p_source and external_id = v_external;

  if v_existing is not null then
    return v_existing;
  end if;

  -- Продлеваем от конца активной лицензии, если она есть.
  select max(expires_at) into v_starts
  from public.licenses
  where user_id = p_user_id
    and status = 'active'
    and expires_at > now();

  v_starts := coalesce(v_starts, now());

  insert into public.licenses (user_id, starts_at, expires_at, source, note)
  values (
    p_user_id,
    v_starts,
    v_starts + make_interval(days => p_days),
    p_source,
    p_note
  )
  returning id into v_license;

  insert into public.license_grants (user_id, license_id, source, external_id, days)
  values (p_user_id, v_license, p_source, v_external, p_days);

  insert into public.audit_log (user_id, action, meta)
  values (
    p_user_id,
    'license_granted',
    jsonb_build_object(
      'license_id', v_license,
      'source', p_source,
      'days', p_days,
      'external_id', v_external
    )
  );

  return v_license;
exception
  -- Гонка двух одновременных webhook'ов на один платёж: победил другой вызов,
  -- отдаём его лицензию вместо ошибки.
  when unique_violation then
    select license_id into v_existing
    from public.license_grants
    where source = p_source and external_id = v_external;
    if v_existing is null then
      raise;
    end if;
    return v_existing;
end;
$$;

revoke execute on function public.grant_license(uuid, integer, text, text, text)
  from public, anon, authenticated;
grant execute on function public.grant_license(uuid, integer, text, text, text)
  to service_role;

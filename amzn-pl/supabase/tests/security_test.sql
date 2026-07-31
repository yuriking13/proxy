-- Тесты модели защиты. Падают с ненулевым кодом при любом нарушении.
-- Запуск: bash scripts/test-db.sh
--
-- Проверяется ровно то, что обещано заказчику:
--   * без активной лицензии расчёт недоступен;
--   * пользователь не может получить чужие проекты;
--   * формулы и справочники комиссий недоступны с клиента;
--   * пользователь не может выдать лицензию сам себе.

\set ON_ERROR_STOP on

-- Возвращает true, если инструкция отклонена по правам или RLS (оба — 42501).
create function pg_temp.denied(p_sql text) returns boolean
language plpgsql as $$
begin
  execute p_sql;
  return false;
exception
  when insufficient_privilege then return true;
end;
$$;

create procedure pg_temp.check(p_name text, p_ok boolean)
language plpgsql as $$
begin
  if p_ok then
    raise notice 'ok   %', p_name;
  else
    raise exception 'FAIL %', p_name;
  end if;
end;
$$;

-- --------------------------------------------------------------------------
-- Данные
-- --------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'a@test'),
  ('22222222-2222-2222-2222-222222222222', 'b@test');

insert into public.projects (id, user_id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001',
   '11111111-1111-1111-1111-111111111111', 'project A'),
  ('bbbbbbbb-0000-0000-0000-000000000002',
   '22222222-2222-2222-2222-222222222222', 'project B');

insert into public.commission_rates (category, rate, valid_from, valid_to)
  values ('home', 0.1500, '2025-01-01', null);

-- --------------------------------------------------------------------------
-- Схема и справочники
-- --------------------------------------------------------------------------
do $$
declare v_ok boolean;
begin
  -- Пересекающиеся периоды одной категории делают выбор ставки
  -- недетерминированным.
  begin
    insert into public.commission_rates (category, rate, valid_from, valid_to)
      values ('home', 0.2000, '2025-06-01', '2026-01-01');
    v_ok := false;
  exception when exclusion_violation then v_ok := true;
  end;
  call pg_temp.check('пересекающиеся периоды комиссий отклоняются', v_ok);

  -- projects.inputs пишется клиентом напрямую — размер обязан быть ограничен.
  begin
    insert into public.projects (user_id, name, inputs)
      values ('11111111-1111-1111-1111-111111111111', 'big',
              jsonb_build_object('x', repeat('a', 70000)));
    v_ok := false;
  exception when check_violation then v_ok := true;
  end;
  call pg_temp.check('projects.inputs ограничен по размеру', v_ok);
end;
$$;

-- --------------------------------------------------------------------------
-- Лицензии: идемпотентность и продление
-- --------------------------------------------------------------------------
do $$
declare
  v_first  uuid;
  v_second uuid;
  v_days   numeric;
  v_count  integer;
begin
  v_first  := public.grant_license(
    '11111111-1111-1111-1111-111111111111', 30, 'stripe', 'pi_ABC');
  v_second := public.grant_license(
    '11111111-1111-1111-1111-111111111111', 30, 'stripe', 'pi_ABC');
  select count(*) into v_count from public.licenses
    where user_id = '11111111-1111-1111-1111-111111111111';
  call pg_temp.check(
    'повтор webhook не создаёт вторую лицензию',
    v_first = v_second and v_count = 1);

  -- Новая оплата продлевает от конца текущей, а не сжигает остаток.
  perform public.grant_license(
    '11111111-1111-1111-1111-111111111111', 30, 'stripe', 'pi_DEF');
  select round(extract(epoch from (max(expires_at) - now())) / 86400)
    into v_days
    from public.licenses where user_id = '11111111-1111-1111-1111-111111111111';
  call pg_temp.check('вторая оплата продлевает лицензию (60 дней)', v_days = 60);

  call pg_temp.check(
    'has_active_license различает пользователей',
    public.has_active_license('11111111-1111-1111-1111-111111111111')
      and not public.has_active_license('22222222-2222-2222-2222-222222222222'));

  call pg_temp.check(
    'rate limit инкрементируется',
    public.bump_rate_limit('11111111-1111-1111-1111-111111111111', 60) = 1
      and public.bump_rate_limit('11111111-1111-1111-1111-111111111111', 60) = 2);
end;
$$;

-- --------------------------------------------------------------------------
-- Изоляция пользователя: всё ниже выполняется от роли authenticated
-- --------------------------------------------------------------------------
do $$
declare v_visible integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub',
                     '11111111-1111-1111-1111-111111111111', true);

  select count(*) into v_visible from public.projects;
  call pg_temp.check('виден только свой проект', v_visible = 1);

  select count(*) into v_visible from public.projects
    where id = 'bbbbbbbb-0000-0000-0000-000000000002';
  call pg_temp.check('чужой проект не читается по прямому id', v_visible = 0);

  call pg_temp.check('справочник комиссий недоступен',
    pg_temp.denied('select * from public.commission_rates'));
  call pg_temp.check('audit_log недоступен',
    pg_temp.denied('select * from public.audit_log'));
  call pg_temp.check('rate_limits недоступен',
    pg_temp.denied('select * from public.rate_limits'));
  call pg_temp.check('license_grants недоступен',
    pg_temp.denied('select * from public.license_grants'));

  call pg_temp.check('нельзя выдать себе лицензию напрямую',
    pg_temp.denied($q$insert into public.licenses (user_id, expires_at)
      values ('11111111-1111-1111-1111-111111111111', now() + interval '999 days')$q$));
  call pg_temp.check('нельзя вызвать grant_license',
    pg_temp.denied($q$select public.grant_license(
      '11111111-1111-1111-1111-111111111111', 999, 'manual', 'hack')$q$));
  call pg_temp.check('нельзя вызвать has_active_license',
    pg_temp.denied($q$select public.has_active_license(
      '22222222-2222-2222-2222-222222222222')$q$));
  call pg_temp.check('нельзя вызвать bump_rate_limit',
    pg_temp.denied($q$select public.bump_rate_limit(
      '11111111-1111-1111-1111-111111111111', 60)$q$));
  call pg_temp.check('нельзя подделать журнал расчётов',
    pg_temp.denied($q$insert into public.calculations
      (project_id, user_id, inputs, results, engine_version)
      values ('aaaaaaaa-0000-0000-0000-000000000001',
              '11111111-1111-1111-1111-111111111111', '{}', '{}', 'x')$q$));
  call pg_temp.check('нельзя создать проект на чужого пользователя',
    pg_temp.denied($q$insert into public.projects (user_id, name)
      values ('22222222-2222-2222-2222-222222222222', 'stolen')$q$));
  -- UPDATE чужой строки не падает с ошибкой, он просто не находит строку:
  -- проверяем именно это, иначе тест ловил бы не тот сценарий.
  update public.projects set name = 'hijacked'
    where id = 'bbbbbbbb-0000-0000-0000-000000000002';
  get diagnostics v_visible = row_count;
  call pg_temp.check('чужой проект не изменяется', v_visible = 0);

  delete from public.projects
    where id = 'bbbbbbbb-0000-0000-0000-000000000002';
  get diagnostics v_visible = row_count;
  call pg_temp.check('чужой проект не удаляется', v_visible = 0);
end;
$$;

-- --------------------------------------------------------------------------
-- Анонимный пользователь не видит ничего
-- --------------------------------------------------------------------------
do $$
declare v_visible integer;
begin
  set local role anon;
  select count(*) into v_visible from public.projects;
  call pg_temp.check('анонимный не видит проектов', v_visible = 0);
  select count(*) into v_visible from public.licenses;
  call pg_temp.check('анонимный не видит лицензий', v_visible = 0);
  call pg_temp.check('анонимный не читает справочник комиссий',
    pg_temp.denied('select * from public.commission_rates'));
end;
$$;

\echo 'все проверки безопасности пройдены'

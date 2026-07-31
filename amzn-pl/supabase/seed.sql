-- seed.sql — ДЕМО-данные для локальной разработки.
-- Реальные ставки комиссий переносятся из Excel-модели заказчика.
insert into public.commission_rates (category, rate, fixed_fee, valid_from) values
  ('home',        0.1500, 0.00, '2025-01-01'),
  ('electronics', 0.0800, 0.00, '2025-01-01'),
  ('apparel',     0.1700, 0.00, '2025-01-01'),
  ('grocery',     0.1500, 0.00, '2025-01-01')
on conflict (category, valid_from) do nothing;

-- ---------------------------------------------------------------------------
-- КАК МЕНЯТЬ СТАВКУ (важно: периоды одной категории не могут пересекаться).
--
-- Строки выше открыты бессрочно (valid_to is null), поэтому простой insert
-- новой ставки будет отклонён constraint'ом commission_rates_no_overlap.
-- Сначала закрываем текущий период, потом открываем следующий — обязательно
-- одной транзакцией, иначе между командами расчёт останется без ставки:
--
--   begin;
--   update public.commission_rates
--      set valid_to = '2026-01-01'
--    where category = 'home' and valid_to is null;
--   insert into public.commission_rates (category, rate, fixed_fee, valid_from)
--   values ('home', 0.1700, 0.00, '2026-01-01');
--   commit;
--
-- Старые строки не удаляются: расчёт, сделанный в прошлом, остаётся
-- объяснимым (в calculations лежат inputs, results и engine_version).
-- ---------------------------------------------------------------------------

-- Выдача лицензии вручную (service_role / SQL-редактор Supabase):
--   select public.grant_license('<uuid пользователя>', 30, 'manual', null,
--                               'оплата на карту');
-- Функция идемпотентна по (source, external_id) и продлевает лицензию от её
-- текущего окончания, а не с сегодняшнего дня.

#!/usr/bin/env bash
# Гарантия того, что расчётный движок не попал во frontend-бандл.
#
# Два независимых контура:
#   1) исходники фронта не импортируют движок (детерминированно, ловит проблему
#      до сборки);
#   2) в собранном бандле нет строковых литералов, которые есть только в
#      движке. Строковые литералы переживают минификацию, в отличие от имён
#      функций — поэтому маркеры выбраны из них.
#
# Маркеры намеренно НЕ включают поля ответа API (referralFee, requiredCapital,
# contributionMarginPerUnit): фронт легально их отображает, и грep по ним давал
# бы ложные срабатывания на каждой сборке.
set -euo pipefail
cd "$(dirname "$0")/.."

FRONTEND_SRC="${FRONTEND_SRC:-frontend/src}"
FRONTEND_DIST="${FRONTEND_DIST:-frontend/dist}"

MARKERS='wholeMonths|daysPerMonth|calcUnitEconomics|ENGINE_VERSION|upfrontInvestment'

status=0

if [ -d "$FRONTEND_SRC" ]; then
  echo "==> проверяю импорты движка в $FRONTEND_SRC"
  if grep -rInE "from ['\"].*(engine/(src|index)|_shared/engine)" "$FRONTEND_SRC"; then
    echo "ОШИБКА: фронт импортирует расчётный движок. Формулы обязаны остаться на сервере." >&2
    status=1
  else
    echo "    импортов движка нет"
  fi
else
  echo "ПРЕДУПРЕЖДЕНИЕ: $FRONTEND_SRC не найден — проверка импортов НЕ выполнялась." >&2
fi

if [ -d "$FRONTEND_DIST" ]; then
  echo "==> ищу маркеры движка в $FRONTEND_DIST"
  if grep -rIlE "$MARKERS" "$FRONTEND_DIST"; then
    echo "ОШИБКА: в бандле найден код движка (маркеры: $MARKERS)." >&2
    status=1
  else
    echo "    маркеров движка нет"
  fi
else
  echo "ПРЕДУПРЕЖДЕНИЕ: $FRONTEND_DIST не найден — проверка бандла НЕ выполнялась." >&2
  echo "  Пока фронт заказчика не подключён к репозиторию, этот контур неактивен." >&2
fi

exit "$status"

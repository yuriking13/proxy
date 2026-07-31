#!/usr/bin/env bash
# Единственный источник истины — engine/src. Копия в functions/_shared/engine
# нужна потому, что supabase functions deploy пакует только каталог functions.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p supabase/functions/_shared/engine
cp engine/src/index.ts engine/src/validate.ts supabase/functions/_shared/engine/
echo "engine synced"

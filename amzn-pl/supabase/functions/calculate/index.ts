// supabase/functions/calculate/index.ts
// Единственная точка расчёта. Формулы не покидают сервер.
//
// Поток: JWT -> rate limit -> лицензия -> валидация -> проект (владение)
//        -> справочник комиссий (service_role) -> engine -> запись calculations.
//
// Деплой: supabase functions deploy calculate
// verify_jwt = true (по умолчанию) — Supabase сам проверяет подпись JWT.

import { createClient } from "npm:@supabase/supabase-js@2";
import { calculate, ENGINE_VERSION } from "../_shared/engine/index.ts";
import { validateInputs } from "../_shared/engine/validate.ts";
import { handleOptions } from "../_shared/cors.ts";
import { jsonError, jsonOk } from "../_shared/http.ts";

/**
 * Обязательные переменные проверяем на старте инстанса: иначе первая же ошибка
 * конфигурации выглядит как «TypeError: undefined» в середине запроса.
 */
function requiredEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`missing required env var: ${name}`);
  return v;
}

const SUPABASE_URL = requiredEnv("SUPABASE_URL");
const SERVICE_ROLE_KEY = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");

const parsedLimit = Number(Deno.env.get("RATE_LIMIT_PER_MIN") ?? "30");
const RATE_LIMIT_PER_MIN =
  Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 30;

/** Потолок тела запроса: 60 месяцев чисел — это единицы килобайт. */
const MAX_BODY_BYTES = 128 * 1024;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Один клиент service_role на инстанс (переиспользуется между запросами).
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

/**
 * Запись в audit_log для отказов. Только на редких путях (отказ), поэтому
 * лишний round-trip не влияет на нормальный расчёт. Сбой аудита не должен
 * менять ответ пользователю.
 */
async function audit(
  userId: string | null,
  action: string,
  meta: Record<string, unknown> = {},
): Promise<void> {
  const { error } = await admin.from("audit_log").insert({
    user_id: userId,
    action,
    meta,
  });
  if (error) console.error("audit_write_error", error.message);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleOptions(req);
  if (req.method !== "POST") return jsonError(req, 405, "method_not_allowed");

  // --- 1. Пользователь из JWT -----------------------------------------------
  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return jsonError(req, 401, "unauthorized");

  const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
  if (userErr || !userData?.user) {
    return jsonError(req, 401, "unauthorized");
  }
  const userId = userData.user.id;

  // --- 2. Rate limit --------------------------------------------------------
  const { data: cnt, error: rlErr } = await admin.rpc("bump_rate_limit", {
    p_user_id: userId,
    p_window_seconds: 60,
  });
  if (rlErr) {
    console.error("rate_limit_error", rlErr.message);
    return jsonError(req, 500, "internal");
  }
  if (Number(cnt) > RATE_LIMIT_PER_MIN) {
    // Логируем только первое превышение в окне: иначе перебор наводняет
    // audit_log ровно теми записями, ради которых он и заводился.
    if (Number(cnt) === RATE_LIMIT_PER_MIN + 1) {
      await audit(userId, "rate_limited", { limit: RATE_LIMIT_PER_MIN });
    }
    return jsonError(req, 429, "rate_limited", {}, { "Retry-After": "60" });
  }

  // --- 3. Лицензия ----------------------------------------------------------
  const { data: licensed, error: licErr } = await admin.rpc(
    "has_active_license",
    { p_user_id: userId },
  );
  if (licErr) {
    console.error("license_check_error", licErr.message);
    return jsonError(req, 500, "internal");
  }
  if (!licensed) {
    await audit(userId, "license_required");
    return jsonError(req, 403, "license_required");
  }

  // --- 4. Тело запроса ------------------------------------------------------
  const declaredLength = Number(req.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return jsonError(req, 413, "payload_too_large");
  }
  let body: unknown;
  try {
    const raw = await req.text();
    // Content-Length можно не прислать (chunked) — проверяем и фактический размер.
    if (raw.length > MAX_BODY_BYTES) {
      return jsonError(req, 413, "payload_too_large");
    }
    body = JSON.parse(raw);
  } catch {
    return jsonError(req, 400, "invalid_json");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return jsonError(req, 400, "invalid_json");
  }

  const { projectId, inputs: rawInputs } = body as {
    projectId?: unknown;
    inputs?: unknown;
  };
  if (typeof projectId !== "string" || !UUID_RE.test(projectId)) {
    return jsonError(req, 400, "project_id_required");
  }

  const validated = validateInputs(rawInputs);
  if (!validated.ok) {
    return jsonError(req, 422, "validation_failed", { errors: validated.errors });
  }
  const inputs = validated.value;

  // --- 5. Владение проектом -------------------------------------------------
  // service_role обходит RLS, поэтому владение проверяем явно.
  // Фильтр по user_id прямо в запросе: одна проверка вместо «нашли и сравнили»,
  // и невозможно случайно ответить данными чужой строки.
  const { data: project, error: projErr } = await admin
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .eq("user_id", userId)
    .maybeSingle();
  if (projErr) {
    console.error("project_lookup_error", projErr.message);
    return jsonError(req, 500, "internal");
  }
  // 404, не 403: не раскрываем существование чужих проектов.
  if (!project) {
    await audit(userId, "project_not_found", { projectId });
    return jsonError(req, 404, "project_not_found");
  }

  // --- 6. Справочник комиссий (только на сервере) ---------------------------
  const today = new Date().toISOString().slice(0, 10);
  const { data: rate, error: rateErr } = await admin
    .from("commission_rates")
    .select("category, rate, fixed_fee, valid_from")
    .eq("category", inputs.category)
    .lte("valid_from", today)
    .or(`valid_to.is.null,valid_to.gt.${today}`)
    .order("valid_from", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (rateErr) {
    console.error("commission_lookup_error", rateErr.message);
    return jsonError(req, 500, "internal");
  }
  if (!rate) return jsonError(req, 422, "unknown_category");

  // --- 7. Расчёт ------------------------------------------------------------
  const results = calculate(inputs, {
    category: rate.category,
    rate: Number(rate.rate),
    fixedFee: Number(rate.fixed_fee),
  });

  // --- 8. Журнал ------------------------------------------------------------
  const { error: insErr } = await admin.from("calculations").insert({
    project_id: projectId,
    user_id: userId,
    inputs,
    results,
    engine_version: ENGINE_VERSION,
  });
  if (insErr) {
    // Расчёт удался — не роняем ответ из-за журнала, но логируем.
    console.error("calculations_insert_error", insErr.message);
  }

  return jsonOk(req, { results });
});

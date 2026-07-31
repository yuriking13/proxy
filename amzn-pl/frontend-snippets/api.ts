// frontend-snippets/api.ts
// Интеграция фронта: auth + вызов calculate. Формул здесь нет и быть не должно.
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY, // anon key публичен by design; защита — RLS
);

export { supabase };

/** Вход по email (magic link / OTP) */
export async function signInWithEmail(email: string) {
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.origin },
  });
  if (error) throw error;
}

/** Статус лицензии — прямой SELECT через RLS (видны только свои строки) */
export async function getLicense() {
  const { data, error } = await supabase
    .from("licenses")
    .select("expires_at, status")
    .eq("status", "active")
    .gt("expires_at", new Date().toISOString())
    .order("expires_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data; // null => лицензии нет, показываем экран оплаты
}

export class ApiError extends Error {
  constructor(public code: string, public status: number, public extra?: unknown) {
    super(code);
    this.name = "ApiError";
  }
}

/**
 * Единственный способ получить расчёт.
 *
 * Коды для UI: license_required -> экран оплаты; rate_limited -> "позже"
 * (Retry-After в заголовке); validation_failed -> подсветка полей (extra.errors
 * содержит список {field, message}); unknown_category -> селект категории;
 * payload_too_large -> слишком длинный план продаж.
 */
export async function runCalculation(projectId: string, inputs: unknown) {
  const { data, error } = await supabase.functions.invoke("calculate", {
    body: { projectId, inputs },
  });

  if (error) {
    // supabase-js кладёт тело ошибки в context
    const ctx = (error as { context?: Response }).context;
    const status = ctx?.status ?? 500;
    let code = "internal";
    let extra: unknown;
    try {
      const body = await ctx?.json();
      code = body?.error ?? code;
      extra = body;
    } catch {
      /* тело не JSON — оставляем код по умолчанию */
    }
    throw new ApiError(code, status, extra);
  }

  // Успешный ответ без results означает рассинхрон контракта с функцией;
  // без этой проверки UI падал бы на чтении полей undefined.
  if (!data || typeof data !== "object" || !("results" in data)) {
    throw new ApiError("malformed_response", 500, data);
  }
  return (data as { results: unknown }).results;
}

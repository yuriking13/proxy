import { corsHeaders } from "./cors.ts";

// Результаты расчёта персональны и лицензионно ограничены: ни браузер, ни
// промежуточные кэши не должны их хранить.
const baseHeaders = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
} as const;

export function jsonOk(req: Request, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { ...corsHeaders(req), ...baseHeaders },
  });
}

export function jsonError(
  req: Request,
  status: number,
  code: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ error: code, ...extra }), {
    status,
    headers: { ...corsHeaders(req), ...baseHeaders, ...headers },
  });
}

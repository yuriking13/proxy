// Разрешённые origin'ы задаются переменной окружения ALLOWED_ORIGINS
// (через запятую), напр.: https://app.example.com,http://localhost:5173
const allowed = (Deno.env.get("ALLOWED_ORIGINS") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "";
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
  // Заголовок ставим только для разрешённого origin; для остальных браузер
  // заблокирует ответ сам. Non-CORS клиенты (curl) не затрагиваются —
  // их защищает JWT, а не CORS.
  if (allowed.includes(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

export function handleOptions(req: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(req) });
}

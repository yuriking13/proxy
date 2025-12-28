// server.js (proxy)
// Purpose: accept text+voice params -> call ElevenLabs from this server -> stream back MP3 to bot-tut.
// Env:
//   PORT=8088
//   ELEVEN_API_KEY=...
//   ELEVEN_BASE_URL=https://api.elevenlabs.io          (optional)
//   ELEVEN_PROXY_SECRET=shared-secret-with-bot-tut     (optional but recommended)

import express from "express";

const PORT = Number(process.env.PORT || 8088);

const ELEVEN_API_KEY = String(process.env.ELEVEN_API_KEY || "").trim();
const ELEVEN_BASE_URL = String(process.env.ELEVEN_BASE_URL || "https://api.elevenlabs.io")
  .trim()
  .replace(/\/+$/, "");

const PROXY_SECRET = String(process.env.ELEVEN_PROXY_SECRET || "").trim();

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

function requireSecret(req, res) {
  // If secret is not set, allow (not recommended).
  if (!PROXY_SECRET) return true;

  const got = String(req.headers["x-proxy-secret"] || "").trim();
  if (got !== PROXY_SECRET) {
    res.status(401).json({ ok: false, error: "bad_secret" });
    return false;
  }
  return true;
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "eleven-proxy",
    hasElevenKey: !!ELEVEN_API_KEY,
    baseUrl: ELEVEN_BASE_URL,
  });
});

/**
 * POST /eleven/tts
 * Headers:
 *   x-proxy-secret: <shared secret> (optional but recommended)
 *
 * Body:
 * {
 *   "text": "Привет!",
 *   "voiceId": "xxxxxxxxxxxx",
 *   "modelId": "eleven_multilingual_v2",
 *   "languageCode": "ru",
 *   "stability": 0.7,
 *   "similarityBoost": 0.8,
 *   "style": 0.1,
 *   "useSpeakerBoost": true
 * }
 *
 * Response:
 *   200 audio/mpeg stream (mp3)
 *   4xx/5xx json error
 */
app.post("/eleven/tts", async (req, res) => {
  try {
    if (!requireSecret(req, res)) return;

    if (!ELEVEN_API_KEY) {
      return res.status(500).json({ ok: false, error: "no_eleven_key" });
    }

    const {
      text,
      voiceId,
      modelId = "eleven_multilingual_v2",
      languageCode = "ru",
      stability = 0.7,
      similarityBoost = 0.8,
      style = 0.1,
      useSpeakerBoost = true,
    } = req.body || {};

    const cleanText = String(text || "").trim();
    const cleanVoiceId = String(voiceId || "").trim();

    if (!cleanText) return res.status(400).json({ ok: false, error: "empty_text" });
    if (!cleanVoiceId) return res.status(400).json({ ok: false, error: "no_voiceId" });

    // ElevenLabs endpoint
    const url = `${ELEVEN_BASE_URL}/v1/text-to-speech/${encodeURIComponent(
      cleanVoiceId
    )}/stream?output_format=mp3_44100_128`;

    const payload = {
      text: cleanText,
      model_id: String(modelId),
      language_code: String(languageCode),
      voice_settings: {
        stability: Number(stability),
        similarity_boost: Number(similarityBoost),
        style: Number(style),
        use_speaker_boost: Boolean(useSpeakerBoost),
      },
    };

    console.log(
      "[proxy][eleven] REQUEST_OUT",
      JSON.stringify({ voiceId: cleanVoiceId, modelId: payload.model_id, textLen: cleanText.length })
    );

    // Important:
    //  - redirect: "manual" so a 302 to a help page can't be silently followed and returned as "mp3"
    //  - Accept: audio/mpeg
    const r = await fetch(url, {
      method: "POST",
      redirect: "manual",
      headers: {
        "xi-api-key": ELEVEN_API_KEY,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
        "User-Agent": "bottut-eleven-proxy/1.0",
      },
      body: JSON.stringify(payload),
    });

    // Block redirects explicitly
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get("location");
      console.log(
        "[proxy][eleven] REDIRECT_BLOCKED",
        JSON.stringify({ status: r.status, location: loc })
      );
      return res.status(502).json({
        ok: false,
        error: "eleven_redirect",
        status: r.status,
        location: loc,
      });
    }

    // Handle non-2xx
    if (!r.ok) {
      const errText = await r.text().catch(() => "");
      console.log(
        "[proxy][eleven] REQUEST_FAIL",
        JSON.stringify({ status: r.status, body: errText.slice(0, 400) })
      );
      return res.status(502).json({
        ok: false,
        error: "eleven_failed",
        status: r.status,
        body: errText.slice(0, 400),
      });
    }

    // Validate content type to avoid returning HTML/JSON as mp3
    const ct = String(r.headers.get("content-type") || "").toLowerCase();
    if (!ct.includes("audio/")) {
      const sample = await r.text().catch(() => "");
      console.log(
        "[proxy][eleven] BAD_CONTENT_TYPE",
        JSON.stringify({ contentType: ct, sample: sample.slice(0, 250) })
      );
      return res.status(502).json({
        ok: false,
        error: "bad_content_type",
        contentType: ct,
        body: sample.slice(0, 250),
      });
    }

    // Stream response back to caller
    res.status(200);
    res.setHeader("Content-Type", "audio/mpeg");
    // Optional hardening
    res.setHeader("Cache-Control", "no-store");

    if (!r.body) {
      const buf = Buffer.from(await r.arrayBuffer());
      return res.end(buf);
    }

    const reader = r.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();

    console.log("[proxy][eleven] REQUEST_OK");
  } catch (e) {
    console.error("[proxy] /eleven/tts failed", e);
    try {
      res.status(500).json({ ok: false, error: "proxy_error", message: e?.message || String(e) });
    } catch {
      // ignаore if headers already sent
    }
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[proxy] listening on :${PORT}`);
  if (!ELEVEN_API_KEY) console.log("[proxy] ELEVEN_API_KEY is required");
  if (!PROXY_SECRET) console.log("[proxy] WARNING: ELEVEN_PROXY_SECRET is not set (endpoint is public)");
});

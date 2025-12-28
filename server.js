import express from "express";

const PORT = Number(process.env.PORT || 8088);

// Proxy security (shared secret with bot-tut)
const PROXY_SECRET = String(process.env.ELEVEN_PROXY_SECRET || "").trim();

// ElevenLabs config (ONLY on proxy host)
const ELEVEN_API_KEY = String(process.env.ELEVEN_API_KEY || process.env.NY_ELEVEN_API_KEY || "").trim();
const ELEVEN_BASE_URL = String(process.env.ELEVEN_BASE_URL || "https://api.elevenlabs.io").trim().replace(/\/+$/, "");

if (!ELEVEN_API_KEY) {
  console.error("[proxy] ELEVEN_API_KEY is required");
}

const app = express();
app.use(express.json({ limit: "1mb" }));

function requireSecret(req, res) {
  if (!PROXY_SECRET) return true; // allow if not set (not recommended)
  const hdr = String(req.headers["x-proxy-secret"] || "").trim();
  if (hdr !== PROXY_SECRET) {
    res.status(401).json({ ok: false, error: "bad_secret" });
    return false;
  }
  return true;
}

// Health
app.get("/health", (_req, res) => res.json({ ok: true }));

/**
 * POST /eleven/tts
 * Body:
 * {
 *   text: string,
 *   voiceId: string,
 *   modelId?: string,
 *   languageCode?: string,
 *   stability?: number,
 *   similarityBoost?: number,
 *   style?: number,
 *   useSpeakerBoost?: boolean
 * }
 *
 * Response: audio/mpeg (mp3 stream)
 */
app.post("/eleven/tts", async (req, res) => {
  try {
    if (!requireSecret(req, res)) return;

    const {
      text,
      voiceId,
      modelId = "eleven_multilingual_v2",
      languageCode = "ru",
      stability = 0.5,
      similarityBoost = 0.75,
      style = 0.0,
      useSpeakerBoost = true,
    } = req.body || {};

    if (!ELEVEN_API_KEY) return res.status(500).json({ ok: false, error: "no_eleven_key" });
    if (!text || !String(text).trim()) return res.status(400).json({ ok: false, error: "empty_text" });
    if (!voiceId || !String(voiceId).trim()) return res.status(400).json({ ok: false, error: "no_voiceId" });

    const url = `${ELEVEN_BASE_URL}/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=mp3_44100_128`;

    const body = {
      text: String(text),
      model_id: String(modelId),
      language_code: String(languageCode),
      voice_settings: {
        stability: Number(stability),
        similarity_boost: Number(similarityBoost),
        style: Number(style),
        use_speaker_boost: Boolean(useSpeakerBoost),
      },
    };

    console.log("[proxy][eleven] REQUEST_OUT", JSON.stringify({ voiceId, modelId, textLen: body.text.length }));

    const r = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": ELEVEN_API_KEY,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
        "User-Agent": "bottut-eleven-proxy/1.0",
      },
      body: JSON.stringify(body),
    });

    if (!r.ok) {
      const errText = await r.text().catch(() => "");
      console.log("[proxy][eleven] REQUEST_FAIL", JSON.stringify({ status: r.status, errText: errText.slice(0, 300) }));
      return res.status(502).json({ ok: false, error: "eleven_failed", status: r.status, body: errText.slice(0, 300) });
    }

    res.status(200);
    res.setHeader("Content-Type", "audio/mpeg");
    // stream body -> client
    if (!r.body) {
      const buf = Buffer.from(await r.arrayBuffer());
      return res.end(buf);
    }

    // Node 18+: ReadableStream -> web stream to Node response
    const reader = r.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (e) {
    console.error("[proxy] /eleven/tts failed", e);
    res.status(500).json({ ok: false, error: "proxy_error", message: e.message });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[proxy] listening on :${PORT}`);
});

import "dotenv/config";
import express from "express";
import cors from "cors";
import { initTelegramClient, scanContract } from "../telegramClient.js";
import { parseScanText, extractLinks } from "../parser.js";

const PORT = Number(process.env.PORT || 3000);

const app = express();

// Allow browser-based frontends to call this API. Restrict via
// CORS_ALLOWED_ORIGINS (comma-separated) in production; wide open by default
// for local development.
const allowedOrigins = process.env.CORS_ALLOWED_ORIGINS
  ? process.env.CORS_ALLOWED_ORIGINS.split(",").map((o) => o.trim())
  : null;

app.use(
  cors({
    origin: allowedOrigins || true,
  })
);

// Very small in-memory cache so repeated lookups of the same address within
// a short window don't re-hit the bot (it almost certainly rate-limits).
const CACHE_TTL_MS = 60_000;
const cache = new Map(); // address -> { data, expiresAt }

function getCached(address) {
  const entry = cache.get(address.toLowerCase());
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(address.toLowerCase());
    return null;
  }
  return entry.data;
}

function setCached(address, data) {
  cache.set(address.toLowerCase(), { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

const ADDRESS_RE = /^(0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/;

app.get("/api/scan/:address", async (req, res) => {
  const { address } = req.params;

  if (!ADDRESS_RE.test(address)) {
    return res.status(400).json({ error: "invalid_address", message: "Doesn't look like a valid contract address." });
  }

  const cached = getCached(address);
  if (cached) {
    return res.json({ ...cached, cached: true });
  }

  try {
    const reply = await scanContract(address);

    if (!reply.ok) {
      const status = reply.error === "timeout" ? 504 : 502;
      return res.status(status).json({ error: reply.error || "bot_error" });
    }

    const parsed = parseScanText(reply.text);
    const links = reply.raw ? extractLinks(reply.raw) : [];
    const result = { ...parsed, links, cached: false };

    if (parsed.found) setCached(address, result);

    return res.json(result);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "internal_error", message: err.message });
  }
});

app.get("/healthz", (_req, res) => res.json({ ok: true }));

initTelegramClient()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`hoodchecker-api listening on :${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Failed to start Telegram client:", err);
    process.exit(1);
  });
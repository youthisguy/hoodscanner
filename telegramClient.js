import "dotenv/config";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { NewMessage } from "telegram/events/index.js";

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const sessionString = process.env.TELEGRAM_SESSION || "";
const botUsername = process.env.HOODCHECKER_BOT_USERNAME || "hoodchecker_bot";
const SCAN_TIMEOUT_MS = Number(process.env.SCAN_TIMEOUT_MS || 25000);

if (!apiId || !apiHash) {
  throw new Error("Missing TELEGRAM_API_ID / TELEGRAM_API_HASH in .env");
}
if (!sessionString) {
  throw new Error("Missing TELEGRAM_SESSION in .env — run `npm run login` first.");
}

const session = new StringSession(sessionString);
const client = new TelegramClient(session, apiId, apiHash, {
  connectionRetries: 5,
});

let botEntity = null;

// --- Simple FIFO queue so we only ever have ONE scan in flight at a time.
// This sidesteps the "which reply belongs to which request" correlation
// problem entirely: whatever the bot sends next IS the answer to the
// request we just sent, because nothing else is running concurrently.
let queue = Promise.resolve();
let currentResolver = null;
let currentTimer = null;
let placeholderMessageId = null;

function extractText(message) {
  // GramJS messages expose `.message` (raw text) and `.text` (rendered text).
  return message.message ?? message.text ?? "";
}

// The bot sends a short "🔍 Scanning ... please wait" status message first,
// then either edits that same message with the real result or sends a
// follow-up. We don't want to resolve on the placeholder.
function isPlaceholder(text) {
  return /scanning|please wait|processing|analyzing/i.test(text) && text.length < 200;
}

function resolveWith(text, rawMessage) {
  clearTimeout(currentTimer);
  const resolve = currentResolver;
  currentResolver = null;
  currentTimer = null;
  placeholderMessageId = null;
  resolve({ ok: true, text, raw: rawMessage });
}

export async function initTelegramClient() {
  await client.connect();
  botEntity = await client.getEntity(botUsername);
  const botId = botEntity.id?.toString();

  // the bot sends the final result as a fresh message.
  client.addEventHandler((event) => {
    const message = event.message;
    if (!message) return;
    if (message.senderId?.toString() !== botId) return;
    if (!currentResolver) return;

    const text = extractText(message);

    if (isPlaceholder(text)) {
      placeholderMessageId = message.id;
      return; // keep waiting
    }

    resolveWith(text, message);
  }, new NewMessage({}));

  return client;
}

/**
 * Sends /scan {contractAddress} to @hoodchecker_bot and waits for its reply.
 * Requests are serialized: if called concurrently, later calls wait for
 * earlier ones to finish so replies can't get cross-matched.
 */
export function scanContract(contractAddress) {
  const job = () =>
    new Promise((resolve) => {
      placeholderMessageId = null;
      currentResolver = resolve;

      currentTimer = setTimeout(() => {
        currentResolver = null;
        placeholderMessageId = null;
        resolve({ ok: false, error: "timeout", text: null });
      }, SCAN_TIMEOUT_MS);

      client.sendMessage(botEntity, { message: `/scan ${contractAddress}` }).catch((err) => {
        clearTimeout(currentTimer);
        currentResolver = null;
        placeholderMessageId = null;
        resolve({ ok: false, error: err.message, text: null });
      });
    });

  // Chain onto the queue so requests run strictly one-at-a-time.
  const result = queue.then(job);
  // Keep the queue alive even if this particular job's result is handled elsewhere.
  queue = result.catch(() => {});
  return result;
}
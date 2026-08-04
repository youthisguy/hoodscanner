// Run once: `npm run login`
// Logs into Telegram as a real user account and prints a session string.
// Paste that string into .env as TELEGRAM_SESSION so the server never has
// to prompt for a login code again.

import "dotenv/config";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import input from "input";

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;

if (!apiId || !apiHash) {
  console.error("Set TELEGRAM_API_ID and TELEGRAM_API_HASH in .env first (from my.telegram.org).");
  process.exit(1);
}

const session = new StringSession("");

const client = new TelegramClient(session, apiId, apiHash, {
  connectionRetries: 5,
});

await client.start({
  phoneNumber: async () => await input.text("Phone number (with country code): "),
  password: async () => await input.text("2FA password (leave blank if none): "),
  phoneCode: async () => await input.text("Login code sent to Telegram: "),
  onError: (err) => console.error(err),
});

console.log("\nLogged in successfully. Add this to your .env as TELEGRAM_SESSION:\n");
console.log(client.session.save());
console.log("\nDo not share this string — it grants full access to the account.\n");

await client.disconnect();
process.exit(0);

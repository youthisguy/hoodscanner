# hoodchecker-api

Wraps the `@hoodchecker_bot` Telegram bot behind a REST API. Sends `/scan {contractAddress}`
using a real Telegram user session, waits for the bot's reply, parses it with regex, and
returns structured JSON your frontend can consume.

## How it works

1. `src/login.js` — one-time interactive login (phone + code) using [GramJS](https://gram.js.org/),
   Telegram's official-ish JS client library (MTProto). It prints a session string.
2. `src/telegramClient.js` — holds that session, sends `/scan {address}` to the bot, and
   listens for the reply. Requests are queued and processed **one at a time** so a reply
   is never accidentally matched to the wrong request.
3. `src/parser.js` — regex/line-based parser that turns the bot's plain-text reply into
   structured JSON (safety score, chain, market data, security flags, holders, etc).
   Also pulls the DEXScreener/DEXTools/Website/Twitter links out of the message's
   Telegram entities (they're hyperlinks, not visible URLs in the text).
4. `src/server.js` — Express API: `GET /api/scan/:address` → JSON.

## Setup

```bash
npm install
cp .env.example .env
```

1. Go to https://my.telegram.org → API Development Tools → create an app.
   Put the `api_id` / `api_hash` into `.env`.
2. Run the one-time login:

   ```bash
   npm run login
   ```

   Enter your phone number, the login code Telegram sends you, and your 2FA password
   if you have one. Copy the printed session string into `.env` as `TELEGRAM_SESSION`.

3. Start the API:

   ```bash
   npm start
   ```

## Usage

```bash
curl http://localhost:3000/api/scan/0xc1a0c3929f5e12b5cfd6ae36f197a45bedf79417
```

Example response shape:

```json
{
  "found": true,
  "name": "Sestri",
  "ticker": "SESTRI",
  "riskEmoji": "🔴",
  "verdict": "DANGER",
  "safetyScore": 43,
  "safetyScoreMax": 100,
  "chain": "ROBINHOOD",
  "age": "3d",
  "contractAddress": "0xc1a0c3929f5e12b5cfd6ae36f197a45bedf79417",
  "priceAndMarket": {
    "mCap": { "label": "MCap", "status": null, "value": "$2.17M", "numeric": 2170000 },
    "fdv": { "...": "..." }
  },
  "securityAnalysis": { "...": "..." },
  "manipulation": { "...": "..." },
  "developer": { "...": "..." },
  "holders": { "...": "..." },
  "dexPresence": { "...": "..." },
  "links": [
    { "label": "DEXScreener", "url": "https://dexscreener.com/..." }
  ],
  "cached": false
}
```

If the bot doesn't recognize the address or sends something unexpected, you'll get
`{ "found": false, "raw": "...", "reason": "unrecognized_format" }` instead of a 500 —
check `raw` to see exactly what it said.

## Things to be aware of

- **This account is now a bot operator, not a passerby.** Telegram and/or the bot owner
  may rate-limit or ban an account that fires off requests too fast. The built-in queue
  serializes requests and there's a 60s in-memory cache per address — tune both to stay
  well under whatever limit `@hoodchecker_bot` enforces, and consider adding your own
  per-IP rate limiting on top of the Express layer.
- **This is scraping a third party's bot**, not a documented API — if the bot's message
  format changes, `parser.js` will need updating. The `found: false` fallback path is
  there so a format change fails loudly (with the raw text attached) instead of silently
  returning garbage.
- **Session string = full account access.** Treat `TELEGRAM_SESSION` like a password;
  never commit `.env` or log the session string anywhere.
- Consider using a dedicated Telegram account for this rather than your personal one.

// Turns a raw @hoodchecker_bot reply (like the sample below) into structured JSON.
//
// 🔴 Sestri ($SESTRI)
// DANGER — Safety Score: 43/100
// Chain: ROBINHOOD | Age: 3d
// 0xc1a0c3929f5e12b5cfd6ae36f197a45bedf79417
// ──────────────────────────────
// 💰 Price & Market
// 🏦 MCap: $2.17M
// ...
//
// Strategy: split into lines, detect section headers (emoji + title, no colon),
// then parse "label: value" lines within each section. Leading status emoji
// (✅ 🔴 🟡 🟢 ⚪) is captured separately as `status` so the frontend can
// color-code rows without re-parsing emoji itself.

const STATUS_EMOJI = ["✅", "🔴", "🟡", "🟢", "⚪", "🟠", "🔥", "🔒"];

const SECTION_HEADERS = {
  "Price & Market": "priceAndMarket",
  "Security Analysis": "securityAnalysis",
  "Manipulation": "manipulation",
  "Developer": "developer",
  "Holders": "holders",
  "DEX Presence": "dexPresence",
};

function stripLeadingEmoji(line) {
  let status = null;
  let rest = line.trim();
  for (const emoji of STATUS_EMOJI) {
    if (rest.startsWith(emoji)) {
      status = emoji;
      rest = rest.slice(emoji.length).trim();
      break;
    }
  }
  return { status, rest };
}

function toNumberLike(raw) {
  // "$2.17M" -> {value: 2170000, display: "$2.17M"}; "43" -> 43; "0.0%" -> 0.0
  const cleaned = raw.replace(/[,$%]/g, "").trim();
  const match = cleaned.match(/^(-?\d+(?:\.\d+)?)([KMB])?$/i);
  if (!match) return null;
  let num = parseFloat(match[1]);
  const suffix = match[2]?.toUpperCase();
  if (suffix === "K") num *= 1e3;
  if (suffix === "M") num *= 1e6;
  if (suffix === "B") num *= 1e9;
  return num;
}

function parseHeaderBlock(lines) {
  const result = {
    name: null,
    ticker: null,
    riskEmoji: null,
    verdict: null,
    safetyScore: null,
    safetyScoreMax: 100,
    chain: null,
    age: null,
    contractAddress: null,
  };

  // Line 0: "🔴 Sestri ($SESTRI)"
  const nameLine = lines[0] ?? "";
  const nameMatch = nameLine.match(/^(\S+)\s+(.+?)\s*\(\$(\w+)\)\s*$/u);
  if (nameMatch) {
    result.riskEmoji = nameMatch[1];
    result.name = nameMatch[2];
    result.ticker = nameMatch[3];
  }

  // Line 1: "DANGER — Safety Score: 43/100"
  const verdictLine = lines[1] ?? "";
  const verdictMatch = verdictLine.match(/^([A-Z ]+)\s*[—-]\s*Safety Score:\s*(\d+)\s*\/\s*(\d+)/);
  if (verdictMatch) {
    result.verdict = verdictMatch[1].trim();
    result.safetyScore = Number(verdictMatch[2]);
    result.safetyScoreMax = Number(verdictMatch[3]);
  }

  // Line 2: "Chain: ROBINHOOD | Age: 3d"
  const chainLine = lines[2] ?? "";
  const chainMatch = chainLine.match(/Chain:\s*([A-Za-z0-9_-]+)\s*\|\s*Age:\s*([^\s|]+)/);
  if (chainMatch) {
    result.chain = chainMatch[1];
    result.age = chainMatch[2];
  }

  // Line 3: the contract address on its own line (EVM 0x... or base58 Solana-style)
  const addrLine = (lines[3] ?? "").trim();
  const addrMatch = addrLine.match(/^(0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/);
  if (addrMatch) {
    result.contractAddress = addrMatch[1];
  }

  return result;
}

/**
 * @param {string} text - raw text of the bot's reply
 * @returns {object} structured scan result. `found: false` if the text doesn't
 *   match the expected scan format (e.g. "contract not found", rate limited, etc).
 */
export function parseScanText(text) {
  if (!text || typeof text !== "string") {
    return { found: false, raw: text ?? null, reason: "empty_response" };
  }

  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^─+$/.test(l)); // drop the divider line

  const header = parseHeaderBlock(lines);

  if (header.safetyScore === null || !header.contractAddress) {
    // Doesn't look like a scan card — probably an error/info message from the bot.
    return { found: false, raw: text, reason: "unrecognized_format" };
  }

  const sections = {
    priceAndMarket: {},
    securityAnalysis: {},
    manipulation: {},
    developer: {},
    holders: {},
    dexPresence: {},
  };

  let currentSection = null;

  // Skip the 4 header lines we already consumed.
  for (const line of lines.slice(4)) {
    // Section header lines have no colon and match a known title.
    const headerTitle = Object.keys(SECTION_HEADERS).find((title) =>
      line.replace(/^\S+\s*/, "").trim() === title
    );
    if (headerTitle) {
      currentSection = SECTION_HEADERS[headerTitle];
      continue;
    }

    // Links footer line, e.g. "DEXScreener | DEXTools | Website | Twitter"
    if (!line.includes(":") && line.includes("|")) {
      continue; // handled separately via extractLinks() using message entities
    }

    if (!currentSection) continue;

    const { status, rest } = stripLeadingEmoji(line);
    const colonIdx = rest.indexOf(":");
    if (colonIdx === -1) continue;

    // Drop any remaining leading emoji/symbol (e.g. "🏦 MCap") that wasn't a
    // recognized status indicator — it's decorative, not a risk signal.
    const label = rest
      .slice(0, colonIdx)
      .replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+/u, "")
      .trim();
    const value = rest.slice(colonIdx + 1).trim();
    const key = label
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, "")
      .trim()
      .replace(/\s+(.)/g, (_, c) => c.toUpperCase());

    const numeric = toNumberLike(value.split("/")[0].split("(")[0]);

    sections[currentSection][key] = {
      label,
      status,
      value,
      numeric: numeric,
    };
  }

  return {
    found: true,
    ...header,
    ...sections,
    raw: text,
  };
}

/**
 * Telegram doesn't render the DEXScreener/DEXTools/Website/Twitter links as
 * plain-text URLs — they come through as `MessageEntityTextUrl` entities on
 * the message. Pass the raw GramJS message object (not just its text) here.
 */
export function extractLinks(rawMessage) {
  const text = rawMessage?.message ?? "";
  const entities = rawMessage?.entities ?? [];
  const links = [];

  for (const entity of entities) {
    if (entity.className === "MessageEntityTextUrl" && entity.url) {
      const label = text.slice(entity.offset, entity.offset + entity.length);
      links.push({ label, url: entity.url });
    }
  }

  return links;
}
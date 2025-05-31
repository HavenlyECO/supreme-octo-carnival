import * as path from "path";
import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: path.resolve(process.cwd(), ".env") });

import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { Api } from "telegram";
import { NewMessage, NewMessageEvent } from "telegram/events";
import OpenAI from "openai";
import axios from "axios";
import Redis from "ioredis";
import { PrismaClient } from "@prisma/client";
import { v4 as uuidv4 } from "uuid";
import { DateTime } from "luxon";
import * as crypto from "crypto";
import schedule from "node-schedule";

// ------------------ ENV AND CONFIG ------------------
function getEnv(name: string, required: boolean = true): string {
  const realKey = Object.keys(process.env).find(
    (k) => k.trim().replace(/^\uFEFF/, "") === name
  );
  const value = realKey ? process.env[realKey] : undefined;
  if (required && (!value || value.trim() === "")) throw new Error(`[GasGuardian] Missing required env var → ${name}`);
  return value ? value.trim() : "";
}

const env = {
  TG_API_ID: parseInt(getEnv("TG_API_ID")),
  TG_API_HASH: getEnv("TG_API_HASH"),
  TG_SESSION: getEnv("TG_SESSION"),
  OWNER_CHAT_ID: parseInt(getEnv("OWNER_CHAT_ID")),
  OPENAI_API_KEY: getEnv("OPENAI_API_KEY"),
  BITLY_TOKEN: getEnv("BITLY_TOKEN", false),
  BLOCKNATIVE_KEY: getEnv("BLOCKNATIVE_KEY", false),
  BITQUERY_KEY: getEnv("BITQUERY_KEY", false),
  CRYPTO_PANIC_KEY: getEnv("CRYPTO_PANIC_KEY", false),
  COINGLASS_KEY: getEnv("COINGLASS_KEY", false),
  DAPPRADAR_KEY: getEnv("DAPPRADAR_KEY", false),
  TGSTAT_KEY: getEnv("TGSTAT_KEY", false),
  REDIS_URL: getEnv("REDIS_URL", false) || "redis://localhost:6379",
  DATABASE_URL: getEnv("DATABASE_URL", false),
};

const config = {
  telegram: {
    apiId: env.TG_API_ID,
    apiHash: env.TG_API_HASH,
    session: env.TG_SESSION,
    ownerChat: env.OWNER_CHAT_ID,
  },
  reply: {
    maxLength: 180,
    minGroupGapSec: 900,
    minUserGapSec: 3600,
    dmRateLimitSec: 60,
    rateBackoffMultiplier: 1.5,
    skipMsg: "SKIP",
    testingLimit: 100,
    languageProbability: 0.85,
    sentimentThreshold: 0.6,
    ctaCooldownHours: 24,
  },
  recruitment: {
    ctaVariants: [
      "DM me '/test' for VIP beta access (limited spots)!",
      "Want early access? DM '/test' to join our beta!",
      "Gas bothering you? DM '/test' for our solution's beta.",
      "Join 100 exclusive testers: DM '/test' now.",
    ],
    betaInstructions:
      "You're in! We'll whitelist your email for the GasGuardian Android beta. Please reply with your Gmail address.",
    confirmationMessage:
      "Thanks! You're now on our VIP beta list. You'll receive an invite within 24h. Early access, priority support, and gas refunds await!",
  },
  api: {
    bitlyToken: env.BITLY_TOKEN,
    blocknativeKey: env.BLOCKNATIVE_KEY,
    bitqueryKey: env.BITQUERY_KEY,
    cryptoPanicKey: env.CRYPTO_PANIC_KEY,
    coinglassKey: env.COINGLASS_KEY,
    dappRadarKey: env.DAPPRADAR_KEY,
    tgstatKey: env.TGSTAT_KEY,
  },
  db: {
    testerTable: "BetaTester",
    interactionTable: "Interaction",
    referralTable: "Referral",
    groupTable: "MonitoredGroup",
    discoveredGroupTable: "DiscoveredGroup",
    discoveryLogTable: "DiscoveryLog",
    abTestTable: "AbTestResult",
  },
  discovery: {
    keywords: [
      "gas", "eth", "ethereum", "defi", "nft", "crypto", "blockchain",
      "airdrop", "layer2", "degen", "token", "polygon", "arbitrum",
      "optimism", "base", "solana", "trading", "yield", "staking",
    ],
    intervalHours: 12,
    maxGroupsPerSearch: 15,
    minGroupSize: 100,
    blacklistedWords: [
      "scam", "porn", "betting", "gambling", "giveaway", "casino", "bonus", "pump", "moon", "hacking",
      "xxx", "sex", "bet", "gamble", "mlm", "signal", "robot", "spam"
    ],
    minPublicMemberCount: 500,
    autoJoinLimit: 2,
  },
  schedules: {
    discoveryTime: "0 2 * * *",
    joinTime: "10,40 * * * *",
    analyticsTime: "0 0 * * *",
    leaderboardTime: "0 12 * * 1",
    auditTime: "15,45 * * * *",
  }
};

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
const redis = new Redis(env.REDIS_URL);
const prisma = new PrismaClient();

// --- UTILITIES ---
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const toBigInt = (v: any): bigint => typeof v === "bigint" ? v : BigInt(v);

// === Bitly Shorten Utility ===
async function bitlyShorten(url: string): Promise<string> {
  if (!config.api.bitlyToken) return url;
  try {
    const res = await axios.post(
      "https://api-ssl.bitly.com/v4/shorten",
      { long_url: url },
      { headers: { Authorization: `Bearer ${config.api.bitlyToken}` } }
    );
    return res.data?.link || url;
  } catch { return url; }
}

// === Blocknative Gas Data ===
async function fetchGasData(): Promise<string> {
  if (!config.api.blocknativeKey) return "";
  try {
    const res = await axios.get("https://api.blocknative.com/gasprices/blockprices", {
      headers: { Authorization: config.api.blocknativeKey }
    });
    const fast = res.data?.blockPrices?.[0]?.estimatedPrices?.[1];
    return fast
      ? `⛽ Gas: ${fast.price} gwei (confidence: ${fast.confidence}%)`
      : "⛽ Gas data unavailable";
  } catch { return "⛽ Gas data unavailable"; }
}

// === Bitquery Token Analytics ===
async function fetchTokenAnalytics(symbol: string): Promise<string> {
  if (!config.api.bitqueryKey) return "";
  try {
    const res = await axios.post(
      "https://graphql.bitquery.io/",
      {
        query: `query { ethereum { dexTrades(options: {limit: 1}, baseCurrency: {is: "${symbol}"}) { tradeAmountUSD } } }`
      },
      { headers: { "X-API-KEY": config.api.bitqueryKey } }
    );
    const usd = res.data?.data?.ethereum?.dexTrades?.[0]?.tradeAmountUSD;
    return usd
      ? `Bitquery: ${symbol} daily trades $${usd.toLocaleString()}`
      : `No trade analytics for ${symbol}`;
  } catch { return ""; }
}

// === CryptoPanic News ===
async function fetchLatestNews(): Promise<string> {
  if (!config.api.cryptoPanicKey) return "";
  try {
    const res = await axios.get(`https://cryptopanic.com/api/v1/posts/`, {
      params: { auth_token: config.api.cryptoPanicKey, kind: "news", public: "false" }
    });
    const post = res.data?.results?.[0];
    return post
      ? `📰 ${post.title}\n${post.url}`
      : "No fresh news.";
  } catch { return "No news data."; }
}

// === Coinglass Futures Analytics ===
async function fetchCoinglassFutures(symbol: string = "ETH"): Promise<string> {
  if (!config.api.coinglassKey) return "";
  try {
    const res = await axios.get("https://open-api.coinglass.com/public/v2/futures/longShortChart", {
      params: { symbol },
      headers: { "coinglassSecret": config.api.coinglassKey }
    });
    const ratio = res.data?.data?.LSRatio;
    return ratio ? `Coinglass L/S Ratio: ${ratio}` : "";
  } catch { return ""; }
}

// === DappRadar Hot Dapps ===
async function fetchHotDapps(): Promise<string> {
  if (!config.api.dappRadarKey) return "";
  try {
    const res = await axios.get("https://api.dappradar.com/4.0/dapps", {
      headers: { "Authorization": config.api.dappRadarKey }
    });
    const dapp = res.data?.results?.[0];
    return dapp
      ? `🔥 Trending Dapp: ${dapp.name} (${dapp.dapp_url})`
      : "";
  } catch { return ""; }
}

// === TGStat Info Utility ===
async function fetchTGStatInfo(usernameOrId: string) {
  if (!config.api.tgstatKey) return null;
  try {
    const res = await axios.get(`https://api.tgstat.com/chats/statistics`, {
      params: {
        token: config.api.tgstatKey,
        chat_id: usernameOrId,
      },
      timeout: 8000,
    });
    return res.data?.response || null;
  } catch (e) {
    return null;
  }
}

function isBlacklistedGroup(g: { title?: string; description?: string; username?: string; memberCount?: number }): boolean {
  const badWords = config.discovery.blacklistedWords;
  const text = `${g.title || ""} ${(g.description || "")}`.toLowerCase();
  const hasBad = badWords.some((w) => text.includes(w));
  const userBad = g.username && badWords.some((w) => g.username!.toLowerCase().includes(w));
  const tooSmall = (g.memberCount ?? 999999) < config.discovery.minPublicMemberCount;
  return hasBad || userBad || tooSmall;
}

// --- Redis-based rate limiters (unchanged) ---

// --- DISCOVERY/JOIN/AUDIT: unchanged except TGStat check is retained ---

// =====================
// = MAIN EVENT HANDLER =
// =====================
const client = new TelegramClient(
  new StringSession(config.telegram.session),
  config.telegram.apiId,
  config.telegram.apiHash,
  { connectionRetries: 5 }
);

function randomCta() {
  const v = config.recruitment.ctaVariants;
  return v[Math.floor(Math.random() * v.length)];
}

async function handleMessage(e: NewMessageEvent) {
  const msg = e.message;
  if (msg.out) return; // Ignore own msgs
  if (!msg.text) return;

  // Only act in groups (not DMs)
  if (msg.peerId?.className === "PeerChannel" || msg.peerId?.className === "PeerChat") {
    // === AI detects intent and English
    const gptRes = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: "You are a Telegram crypto expert assistant. Does the following message express pain, need, or curiosity about gas fees, DeFi, Dapps, NFTs, trading, or news? If yes, reply 'YES' and summarize the main ask in 10 words. If no, reply 'NO'." },
        { role: "user", content: msg.text }
      ],
      max_tokens: 60,
      temperature: 0,
    });
    const aiReply = gptRes.choices?.[0]?.message?.content || "";
    const convertable = aiReply.startsWith("YES");

    let replyParts: string[] = [];

    // Contextual reply: only if user is asking something relevant
    if (convertable) {
      // Add API values (value-first reply)
      replyParts.push(await fetchGasData());
      replyParts.push(await fetchLatestNews());
      replyParts.push(await fetchHotDapps());
      replyParts.push(await fetchCoinglassFutures());
      // If specific token, include Bitquery stats (detect via AI for symbol)
      if (/(\bETH\b|\bMATIC\b|\bARB\b|\bOP\b|\bBASE\b|\bBNB\b)/i.test(msg.text)) {
        const match = msg.text.match(/(\bETH\b|\bMATIC\b|\bARB\b|\bOP\b|\bBASE\b|\bBNB\b)/i);
        if (match) replyParts.push(await fetchTokenAnalytics(match[1].toUpperCase()));
      }
      replyParts = replyParts.filter(Boolean);

      // Add CTA with Bitly invite link
      let appUrl = "https://play.google.com/store/apps/details?id=com.gasguardian"; // <--- update with your link
      if (config.api.bitlyToken) appUrl = await bitlyShorten(appUrl + "?utm_source=telegram&utm_medium=bot&utm_campaign=beta");
      replyParts.push(`\n${randomCta()} ${appUrl}`);
    }

    // Compose & send reply (value + CTA)
    if (replyParts.length > 0) {
      const replyTxt = replyParts.join("\n").slice(0, config.reply.maxLength * 2);
      await e.reply({ message: replyTxt });
      // Log for AB analytics
      await prisma.interaction.create({
        data: {
          id: uuidv4(),
          groupId: toBigInt(msg.peerId.channelId ?? msg.peerId.chatId ?? 0),
          userId: msg.senderId ? msg.senderId.toString() : "",
          message: msg.text,
          reply: replyTxt,
          sentAt: new Date(),
        }
      });
    }
  }

  // Handle DMs for /test CTA
  if (msg.peerId?.className === "PeerUser" && /^\/test/i.test(msg.text)) {
    await e.reply({ message: config.recruitment.betaInstructions });
    // log, etc...
  }
}

// --- SCHEDULED JOBS/ADMIN HANDLERS UNCHANGED ---

async function main() {
  await client.start({
    phoneNumber: async () => "",
    password: async () => "",
    phoneCode: async () => "",
    onError: (err) => console.error(err),
  });
  // ... scheduled jobs setup, group join, audit, etc, from your prior logic

  // NEW: Message handler for all group/user DMs
  client.addEventHandler(handleMessage, new NewMessage({}));
}
main().catch(console.error);

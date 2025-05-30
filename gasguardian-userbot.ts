/**
 * GasGuardian UserBot v4.0
 * 
 * Node 20+, tsx, Telethon (gramjs), Redis, Postgres/Prisma.
 * 
 * Features:
 * - Gas alerts, DeFi alpha, and VIP onboarding via Telegram DM.
 * - Persistent per-user Bitly links for analytic funnels.
 * - Onchain gas alerts, Alpha feed, owner stats export, and more.
 * 
 * See config below for tunables. 
 */

import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { Api } from "telegram";
import Redis from "ioredis";
import { PrismaClient } from "@prisma/client";
import axios from "axios";
import { DateTime } from "luxon";
import csvStringify from "csv-stringify/lib/sync";

// --- CONFIG ---
const config = {
  telegram: {
    apiId: Number(process.env.TG_API_ID),
    apiHash: process.env.TG_API_HASH as string,
    session: process.env.TG_SESSION as string,
    ownerChatId: Number(process.env.OWNER_CHAT_ID),
  },
  bitly: {
    token: process.env.BITLY_TOKEN as string,
    baseUrl: "https://api-ssl.bitly.com/v4",
    domain: "bit.ly",
  },
  redis: {
    url: process.env.REDIS_URL || "redis://localhost:6379",
  },
  db: {},
  reply: {
    minGapSec: 45,
    rateBackoffBase: 1.5,
    emojiPools: [
      ["⛽", "🐳", "⚡", "🦄", "🍔"],
      ["🚀", "💧", "🔮", "🦙", "🥷"],
    ],
    templates: [
      "⛽ Gas low – swap now. {cta}",
      "🐳 Gwei dipping soon – eyes on the prize. {cta}",
      "⚡ Quick alpha: watch for gas dips. {cta}",
      "Wait for lower gwei—patience = profits. {cta}",
      "Gas fees hurting? Relief soon. {cta}",
    ],
    skipMsg: "SKIP",
  },
  onboarding: {
    testerTable: "internal_testers",
    testerDigestHourUTC: 0,
    playStoreLinkBase: "<PLAYSTORE_LINK>", // Only sent via DM after whitelisting
  },
  alpha: {
    enable: true,
    alphaSources: ["blocknative", "dappRadar", "cryptopanic"],
    triggerPhrases: ["alpha", "narrative", "degen", "airdrop"],
  },
  gas: {
    enable: true,
    supportedChains: [
      { name: "Ethereum", id: 1, symbol: "ETH" },
      { name: "Base", id: 8453, symbol: "ETH" },
      { name: "Arbitrum", id: 42161, symbol: "ETH" },
      { name: "Optimism", id: 10, symbol: "ETH" },
    ],
    minAlertIntervalMin: 10,
  },
  ab: {
    weeklyReviewDay: 0, // Sunday
    minVariants: 3,
  },
  profile: {
    enrichment: true,
  },
  analytics: {
    exportCommand: "/export_stats",
  },
};

// --- CLIENTS ---
const redis = new Redis(config.redis.url);
const prisma = new PrismaClient();
let client: TelegramClient;

// --- UTILS ---
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
/** Backoff exponentially if rate-limited or warned by Telegram. */
async function rateBackoff(current: number) {
  const next = Math.ceil(current * config.reply.rateBackoffBase);
  await sleep(next * 1000);
  return next;
}
/** Get last reply timestamp for a chat from Redis. */
async function canReply(chatId: number): Promise<boolean> {
  const last = await redis.get(`replygap:${chatId}`);
  if (!last) return true;
  const since = Date.now() - Number(last);
  return since > config.reply.minGapSec * 1000;
}
/** Mark reply timestamp for a chat in Redis. */
async function markReply(chatId: number) {
  await redis.set(`replygap:${chatId}`, Date.now());
}
/** Choose reply variant (A/B) and emoji, evolve over time. */
async function getReplyVariant(userId: number): Promise<{ text: string; emoji: string }> {
  // Simple: alternate pools per userId
  const poolId = userId % config.reply.emojiPools.length;
  const template = config.reply.templates[Math.floor(Math.random() * config.reply.templates.length)];
  const emoji = config.reply.emojiPools[poolId][Math.floor(Math.random() * config.reply.emojiPools[poolId].length)];
  return { text: template.replace("{cta}", ""), emoji };
}
/** Fetch or create a persistent Bitly link for a user. */
async function getOrCreateBitly(userId: number): Promise<string> {
  const key = `bitly:${userId}`;
  let url = await redis.get(key);
  if (url) return url;
  const longUrl = `https://t.me/GasGuardianBot?start=${userId}`;
  try {
    const resp = await axios.post(
      `${config.bitly.baseUrl}/shorten`,
      { long_url: longUrl, domain: config.bitly.domain },
      { headers: { Authorization: `Bearer ${config.bitly.token}` } }
    );
    url = resp.data.link;
    await redis.set(key, url);
    return url;
  } catch (e) {
    throw new Error("Bitly link error");
  }
}
/** Log reply, Bitly click, and conversion to Postgres. */
async function logInteraction(params: {
  messageId: number;
  userId: number;
  reply: string;
  bitly?: string;
  event: "reply" | "click" | "conversion";
  meta?: object;
}) {
  await prisma.interactionLog.create({
    data: {
      messageId: params.messageId,
      userId: params.userId,
      reply: params.reply,
      bitly: params.bitly,
      event: params.event,
      meta: params.meta ?? {},
      timestamp: new Date(),
    },
  });
}
/** Onchain gas: fetch current gas for a chain (via Blocknative/Bitquery/CoinGecko fallback). */
async function fetchGas(chainId: number): Promise<number | null> {
  // Blocknative example (pseudo)
  try {
    const resp = await axios.get(`https://api.blocknative.com/gasprices/blockprices?chainid=${chainId}`, {
      headers: { Authorization: process.env.BLOCKNATIVE_KEY },
    });
    return resp.data.blockPrices[0]?.estimatedPrices[0]?.price ?? null;
  } catch {
    // Fallback: CoinGecko
    try {
      const coingecko = await axios.get(`https://api.coingecko.com/api/v3/simple/gas_price?network=${chainId}`);
      return coingecko.data.standard ?? null;
    } catch {
      return null;
    }
  }
}
/** Alpha feed: aggregate and dedupe alpha news from multiple sources. */
async function fetchAlphaFeed(): Promise<string[]> {
  // Example with CryptoPanic (add others as needed)
  try {
    const resp = await axios.get(`https://cryptopanic.com/api/v1/posts/?auth_token=${process.env.CRYPTO_PANIC_KEY}&kind=news`);
    return resp.data.results.slice(0, 3).map((r: any) => r.title);
  } catch {
    return [];
  }
}
/** Export stats as CSV. */
async function exportStats(): Promise<string> {
  const testers = await prisma[config.onboarding.testerTable].findMany();
  const clicks = await prisma.interactionLog.findMany({ where: { event: "click" } });
  return csvStringify([["tgId", "email", "timestamp"], ...testers.map(t => [t.tgId, t.email, t.timestamp])]);
}

// --- CORE HANDLERS ---

/** DM On-Boarding: /test → ask email → store → confirm. */
async function handleTestOnboarding(event: Api.Message, userId: number) {
  await client.sendMessage(userId, { message: "Thanks for volunteering! Please reply with your Google-account email for Play-Store whitelisting." });
  // Wait for email reply (simplified, in real use set up state tracking)
}
/** Store tester in Postgres. */
async function storeTester(userId: number, email: string) {
  await prisma[config.onboarding.testerTable].create({
    data: { tgId: userId, email, timestamp: new Date() },
  });
  await client.sendMessage(userId, { message: "You’ll be whitelisted within 24 h—watch for a Play Store invite. VIP features & direct support await!" });
}
/** Digest at 00 UTC: new testers/key metrics to owner. */
async function sendDailyDigest() {
  const now = DateTime.utc();
  if (now.hour !== config.onboarding.testerDigestHourUTC) return;
  const since = now.minus({ days: 1 }).toJSDate();
  const testers = await prisma[config.onboarding.testerTable].findMany({ where: { timestamp: { gte: since } } });
  const digest = `Daily Digest: ${testers.length} new testers\n` + testers.map(t => `${t.tgId} | ${t.email}`).join("\n");
  await client.sendMessage(config.telegram.ownerChatId, { message: digest });
}
/** Alpha feed and gas alert commands. */
async function handleAlphaOrGas(event: Api.Message, userId: number, text: string) {
  if (config.alpha.enable && config.alpha.triggerPhrases.some(p => text.toLowerCase().includes(p))) {
    const alpha = await fetchAlphaFeed();
    if (alpha.length) {
      await client.sendMessage(userId, { message: "Top alpha:\n" + alpha.join("\n") });
      return true;
    }
  }
  if (config.gas.enable && /gas/i.test(text)) {
    const base = config.gas.supportedChains.find(c => text.toLowerCase().includes(c.name.toLowerCase()));
    if (base) {
      const gwei = await fetchGas(base.id);
      if (gwei != null) {
        await client.sendMessage(userId, { message: `${base.name} gas: ${gwei} gwei` });
        return true;
      }
    }
  }
  return false;
}
/** Onchain gas alert opt-in. */
async function handleGasAlertOptIn(userId: number, chainId: number, threshold: number) {
  await redis.set(`gasalert:${userId}:${chainId}`, threshold);
  await client.sendMessage(userId, { message: `Gas alert set for ${config.gas.supportedChains.find(c => c.id === chainId)?.name} < ${threshold} gwei.` });
}
/** Handle profile enrichment. */
async function enrichProfile(userId: number, msg: string) {
  // Parse wallet address, topics, etc.
  // Save to Postgres
  if (!config.profile.enrichment) return;
  const address = (msg.match(/0x[a-fA-F0-9]{40}/) || [])[0];
  if (address) {
    await prisma.userProfile.upsert({
      where: { tgId: userId },
      update: { address },
      create: { tgId: userId, address },
    });
    await client.sendMessage(userId, { message: `Got your wallet: ${address}.` });
  }
}

/** Owner-only: export stats. */
async function handleOwnerExport(userId: number) {
  if (userId !== config.telegram.ownerChatId) return;
  const csv = await exportStats();
  await client.sendMessage(userId, { message: "CSV Export:\n" + csv });
}

// --- MAIN LOOP & EVENTS ---
async function main() {
  client = new TelegramClient(new StringSession(config.telegram.session), config.telegram.apiId, config.telegram.apiHash, { connectionRetries: 5 });
  await client.start();

  client.addEventHandler(async (event: any) => {
    if (!(event instanceof Api.Message)) return;
    const msg = event.message?.message || "";
    const userId = event.message?.peerId?.userId || event.message?.fromId?.userId;
    if (!userId) return;

    // Skip if admin/mod/bot and not directly addressed
    if (event.message?.peerId?.chatId && event.message?.fromId?.userId) {
      // TODO: Add admin/mod/bot check via Telegram API
      // For now, assume all users are valid
    }

    // Anti-spam: enforce reply gap
    if (!(await canReply(userId))) return;

    // Fail-safe: unable to add value or recruit?
    if (!msg || (!/gas|alpha|swap|degen|test/i.test(msg) && !/\/test/.test(msg))) {
      await client.sendMessage(userId, { message: config.reply.skipMsg });
      return;
    }

    // Onboarding: /test
    if (/\/test/.test(msg)) {
      await handleTestOnboarding(event, userId);
      await markReply(userId);
      return;
    }

    // Handle Play Store email
    if (/^[^@\s]+@gmail\.com$/.test(msg.trim())) {
      await storeTester(userId, msg.trim());
      await markReply(userId);
      return;
    }

    // Alpha/gas feed
    if (await handleAlphaOrGas(event, userId, msg)) {
      await markReply(userId);
      return;
    }

    // Onchain gas alert opt-in (e.g. "alert eth <15")
    if (/alert\s+(\w+)\s*<\s*(\d+)/i.test(msg)) {
      const [, chain, threshold] = msg.match(/alert\s+(\w+)\s*<\s*(\d+)/i)!;
      const chainId = config.gas.supportedChains.find(c => c.name.toLowerCase().startsWith(chain.toLowerCase()))?.id;
      if (chainId) {
        await handleGasAlertOptIn(userId, chainId, Number(threshold));
        await markReply(userId);
        return;
      }
    }

    // Profile enrichment (wallet address etc.)
    await enrichProfile(userId, msg);

    // Default: reply with AB variant + CTA + per-user Bitly
    const { text, emoji } = await getReplyVariant(userId);
    const bitly = await getOrCreateBitly(userId);
    const reply = `${emoji} ${text} 👉 ${bitly} | DM “/test” for VIP Android beta.`;
    await client.sendMessage(userId, { message: reply });
    await logInteraction({ messageId: Number(event.message?.id), userId, reply, bitly, event: "reply" });
    await markReply(userId);
  });

  // Scheduler: daily digest, A/B review, etc.
  setInterval(async () => {
    await sendDailyDigest();
    // Weekly A/B review: rank reply variants by CTR/conversion
    const now = DateTime.utc();
    if (now.weekday === config.ab.weeklyReviewDay && now.hour === 1) {
      // TODO: Analyze logs, update emoji/template pools
    }
  }, 60_000);

  // Listen for Bitly click webhook (pseudo, must be set up externally)
  // app.post("/bitly-webhook", async (req, res) => {
  //   const { userId } = req.body;
  //   await logInteraction({ messageId: 0, userId, reply: "", bitly: await getOrCreateBitly(userId), event: "click" });
  //   res.sendStatus(200);
  // });
}

main().catch(console.error);

/**
 * README
 * 
 * 1. Create .env with TG_API_ID, TG_API_HASH, TG_SESSION, OWNER_CHAT_ID, BITLY_TOKEN, BLOCKNATIVE_KEY, CRYPTO_PANIC_KEY
 * 2. Set up Postgres DB and Prisma schema (see models: internal_testers, interactionLog, userProfile).
 * 3. Run: npx tsx gasguardian-userbot.ts
 * 4. To export stats, as owner DM /export_stats to the bot.
 */
/* ==========================================================
   GasGuardian – Advanced Multi‑Chain Crypto Assistant
   USERBOT (not a channel bot)
   Version: 2.0.2 – 2025‑05‑31
   ========================================================== */

/* ---------- 1. LOAD & VALIDATE ENVIRONMENT --------------- */
import * as path from "path";
import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: path.resolve(process.cwd(), ".env") });

function getEnv(name: string, required: boolean = true): string {
  const realKey = Object.keys(process.env).find(
    (k) => k.trim().replace(/^\uFEFF/, "") === name
  );
  const value = realKey ? process.env[realKey] : undefined;
  if (required && (!value || value.trim() === ""))
    throw new Error(`[GasGuardian] Missing required env var → ${name}`);
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
  REDIS_URL: getEnv("REDIS_URL", false) || "redis://localhost:6379",
  DATABASE_URL: getEnv("DATABASE_URL", false),
};

/* ---------- 2. DEPENDENCIES ------------------------------ */
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

/* ---------- 3. CLIENT INITIALISATION --------------------- */
const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
const redis = new Redis(env.REDIS_URL);
const prisma = new PrismaClient();

/* ---------- 4. BOT CONFIG -------------------------------- */
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
  },
  db: {
    testerTable: "BetaTester",
    interactionTable: "Interaction",
    analyticsTable: "Analytics",
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
    blacklistedWords: ["scam", "porn", "betting", "gambling"],
    minPublicMemberCount: 500,
    autoJoinLimit: 2,
  },
  schedules: {
    discoveryTime: "*/1 * * * *", // every 1 minute
    joinTime: "10,40 * * * *",    // every 30 minutes
    analyticsTime: "0 0 * * *",
    leaderboardTime: "0 12 * * 1",
  },
};

/* ---------- 5. CHAINS, ENUMS, TYPES ---------------------- */
const chains = [
  { id: 1, name: "Ethereum", symbol: "ETH", emoji: "⛽" },
  { id: 137, name: "Polygon", symbol: "MATIC", emoji: "🟣" },
  { id: 56, name: "BNB Chain", symbol: "BNB", emoji: "🟨" },
  { id: 42161, name: "Arbitrum", symbol: "ETH", emoji: "🔵" },
  { id: 10, name: "Optimism", symbol: "ETH", emoji: "🔴" },
  { id: 8453, name: "Base", symbol: "ETH", emoji: "🔷" },
];

enum MessageIntentType {
  GAS_COMPLAINT = "gas_complaint",
  TOKEN_INQUIRY = "token_inquiry",
  DEFI_QUESTION = "defi_question",
  NFT_DISCUSSION = "nft_discussion",
  GENERAL_CRYPTO = "general_crypto",
  OFF_TOPIC = "off_topic",
}

enum DataSourceType {
  BLOCKNATIVE = "blocknative",
  BITQUERY = "bitquery",
  COINGECKO = "coingecko",
  CRYPTOPANIC = "cryptopanic",
  COINGLASS = "coinglass",
  DAPPRADAR = "dappradar",
  GPT = "gpt",
}

interface AnalyzedMessage {
  isEnglish: boolean;
  sentiment: number;
  intent: MessageIntentType;
  entities: { chains: string[]; tokens: string[]; protocols: string[] };
  keywords: string[];
}

interface DataInsight {
  text: string;
  source: DataSourceType;
  relevanceScore: number;
  timestamp: Date;
}

interface ReplyVariant {
  template: string;
  emoji: string;
  cta: boolean;
  bitlyUrl?: string;
}

interface DiscoveredGroup {
  id: number;
  title: string;
  username?: string;
  memberCount?: number;
  description?: string;
  isChannel: boolean;
  discoveredAt: Date;
  keyword: string;
  lastCheckedAt: Date;
  isMonitored: boolean;
  autoJoinStatus?: string;
}

/* ---------- 6. UTILITIES --------------------------------- */
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const toBigInt = (v: any): bigint => {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(v);
  if (typeof v === "string") return BigInt(v);
  return BigInt(v.toString());
};
/* ... more utilities ... */
/* ---------- 6. UTILITIES (continued) --------------------- */
async function canReplyInGroup(chatId: number) {
  const key = `ratelimit:group:${chatId}`;
  const last = await redis.get(key);
  return !last || Date.now() - parseInt(last) > config.reply.minGroupGapSec * 1e3;
}
async function canReplyToUser(uid: number) {
  const key = `ratelimit:user:${uid}`;
  const last = await redis.get(key);
  return !last || Date.now() - parseInt(last) > config.reply.minUserGapSec * 1e3;
}
async function canReplyInDM(uid: number) {
  const key = `ratelimit:dm:${uid}`;
  const last = await redis.get(key);
  return !last || Date.now() - parseInt(last) > config.reply.dmRateLimitSec * 1e3;
}
async function markReplyInGroup(cid: number) {
  await redis.set(`ratelimit:group:${cid}`, Date.now().toString());
}
async function markReplyToUser(uid: number) {
  await redis.set(`ratelimit:user:${uid}`, Date.now().toString());
}
async function markReplyInDM(uid: number) {
  await redis.set(`ratelimit:dm:${uid}`, Date.now().toString());
}
async function canShowCTA(uid: number) {
  const key = `cta:cooldown:${uid}`;
  const last = await redis.get(key);
  return !last || Date.now() - parseInt(last) > config.reply.ctaCooldownHours * 3600 * 1e3;
}
async function markCTAShown(uid: number) {
  await redis.set(`cta:cooldown:${uid}`, Date.now().toString());
}
function generateTrackingId(): string {
  return crypto.randomBytes(4).toString("hex");
}

/* ---------- 7. DISCOVERY & OWNER COMMANDS ---------------- */
async function discoverGroups(client: TelegramClient) {
  console.log(`[${new Date().toISOString()}] Starting group discovery…`);
  let total = 0;
  for (const kw of config.discovery.keywords) {
    try {
      const result = await client.invoke(
        new Api.contacts.Search({ q: kw, limit: config.discovery.maxGroupsPerSearch })
      );
      for (const chat of result.chats) {
        if (!("title" in chat)) continue;
        const chatIdBig = toBigInt(chat.id);
        const title = (chat as any).title as string;
        const username = (chat as any).username as string | undefined;
        const isChannel = !!(chat as any).broadcast;
        const memberCount = (chat as any).participantsCount ?? undefined;
        const isPublicChannel =
          isChannel &&
          !!username &&
          !username.startsWith("private") &&
          memberCount &&
          memberCount >= config.discovery.minPublicMemberCount;

        await prisma[config.db.discoveredGroupTable].upsert({
          where: { id: chatIdBig },
          update: {
            lastCheckedAt: new Date(),
            title,
            username,
            memberCount,
            isMonitored: false,
            autoJoinStatus: isPublicChannel ? "eligible" : "ineligible",
          },
          create: {
            id: chatIdBig,
            title,
            username,
            memberCount,
            isChannel,
            discoveredAt: new Date(),
            lastCheckedAt: new Date(),
            keyword: kw,
            isMonitored: false,
            autoJoinStatus: isPublicChannel ? "eligible" : "ineligible",
          },
        });
        await prisma[config.db.discoveryLogTable].create({
          data: { groupId: chatIdBig, title, keyword: kw, timestamp: new Date(), memberCount },
        });
        total++;
      }
      await sleep(2e3);
    } catch (e) {
      console.error(`Discovery error for '${kw}':`, e);
    }
  }
  console.log(`[${new Date().toISOString()}] Discovery complete – ${total} groups`);
  if (total) await sendDiscoveryReport(client);
}

async function joinHighlyConvertibleGroups(client: TelegramClient) {
  const candidates = await prisma[config.db.discoveredGroupTable].findMany({
    where: {
      isChannel: true,
      username: { not: null },
      memberCount: { gte: config.discovery.minPublicMemberCount },
      autoJoinStatus: "eligible",
      isMonitored: false,
    },
    orderBy: { memberCount: "desc" },
    take: config.discovery.autoJoinLimit,
  });

  for (const group of candidates) {
    try {
      await client.invoke(
        new Api.channels.JoinChannel({
          channel: group.username!.startsWith("@")
            ? group.username
            : `@${group.username}`,
        })
      );
      await prisma[config.db.discoveredGroupTable].update({
        where: { id: toBigInt(group.id) },
        data: {
          isMonitored: true,
          autoJoinStatus: "joined",
        },
      });
      console.log(`[Auto-Join] Joined & monitoring: @${group.username} (${group.id})`);
      await sleep(2000);
    } catch (err) {
      await prisma[config.db.discoveredGroupTable].update({
        where: { id: toBigInt(group.id) },
        data: {
          autoJoinStatus: "failed",
        },
      });
      console.warn(`[Auto-Join] Failed to join @${group.username}:`, err);
    }
  }
}

async function sendDiscoveryReport(client: TelegramClient) {
  const yesterday = DateTime.utc().minus({ days: 1 }).toJSDate();
  const groups = await prisma[config.db.discoveredGroupTable].findMany({
    where: {
      OR: [{ discoveredAt: { gte: yesterday } }, { lastCheckedAt: { gte: yesterday } }],
    },
    orderBy: { memberCount: "desc" },
    take: 20,
  });
  if (!groups.length) return;
  let msg = "🔍 **Group Discovery Report**\n\n";
  msg += `Found ${groups.length} new/updated groups:\n\n`;
  for (const g of groups) {
    const members = g.memberCount ? `(~${g.memberCount} members)` : "";
    const uname = g.username ? `@${g.username}` : "private";
    msg += `• ${g.title} – ${uname} ${members}\n`;
  }
  const total = await prisma[config.db.discoveredGroupTable].count();
  msg += `\nTotal tracked groups: ${total}\n`;
  msg +=
    "\nUse /monitor <group_id> to start monitoring.\nAuto-join: Only high-convertible public channels (eligibility: memberCount ≥ " +
    config.discovery.minPublicMemberCount +
    " & public username, up to " +
    config.discovery.autoJoinLimit +
    " per join interval)";
  await client.sendMessage(config.telegram.ownerChat, { message: msg });
}

/* ---------- 8. ANALYTICS / LEADERBOARD ------------------- */
// ... full analytics, leaderboard, A/B test, fetcher, handler, and main runtime logic continues ...
/* ---------- 8. ANALYTICS / LEADERBOARD ------------------- */
async function generateOwnerStats(): Promise<string> {
  const testers = await prisma[config.db.testerTable].count();
  const totalReplies = await prisma[config.db.interactionTable].count({
    where: { eventType: "group_reply" },
  });
  const clicks = await prisma[config.db.interactionTable].count({
    where: { eventType: "click" },
  });
  const onboard = await prisma[config.db.interactionTable].count({
    where: { eventType: "onboarding" },
  });
  const sourceStats = await prisma[config.db.interactionTable].groupBy({
    by: ["source"],
    _count: { source: true },
    where: { source: { not: null } },
  });
  const conversionRate = totalReplies ? ((onboard / totalReplies) * 100).toFixed(2) : "0.00";
  const ctr = totalReplies ? ((clicks / totalReplies) * 100).toFixed(2) : "0.00";

  let msg = "📊 **GasGuardian Stats**\n\n";
  msg += `Beta Testers: ${testers}/${config.reply.testingLimit}\n`;
  msg += `Group Replies: ${totalReplies}\n`;
  msg += `Link Clicks: ${clicks}\n`;
  msg += `Onboarded Users: ${onboard}\n\n`;
  msg += `CTR: ${ctr}%\nConversion Rate: ${conversionRate}%\n\n`;
  msg += "**Data Sources:**\n";
  for (const s of sourceStats) msg += `${s.source}: ${s._count.source}\n`;
  return msg;
}

async function generateReferralLeaderboard(): Promise<string> {
  const referrers = await prisma[config.db.referralTable].groupBy({
    by: ["referrerId"],
    _count: { referredId: true },
    orderBy: { _count: { referredId: "desc" } },
    take: 10,
  });
  let board = "🏆 **Beta Tester Leaderboard**\n\n";
  if (!referrers.length) return board + "No referrals yet.";
  for (let i = 0; i < referrers.length; i++) {
    const r = referrers[i];
    const tester = await prisma[config.db.testerTable].findUnique({
      where: { tgUserId: r.referrerId },
    });
    const name = tester ? `User ${tester.tgUserId}` : "Unknown User";
    board += `${i + 1}. ${name}: ${r._count.referredId} invites\n`;
  }
  return board;
}

async function getCTAVariant(uid: number) {
  return config.recruitment.ctaVariants[uid % config.recruitment.ctaVariants.length];
}
async function logABTest(uid: number, idx: number, type: string) {
  await prisma[config.db.abTestTable].create({
    data: { userId: uid, variantIndex: idx, eventType: type, timestamp: new Date() },
  });
}
async function analyzeABTestResults() {
  const res = [];
  for (let i = 0; i < config.recruitment.ctaVariants.length; i++) {
    const impressions = await prisma[config.db.abTestTable].count({
      where: { variantIndex: i, eventType: "impression" },
    });
    const clicks = await prisma[config.db.abTestTable].count({
      where: { variantIndex: i, eventType: "click" },
    });
    const conversions = await prisma[config.db.abTestTable].count({
      where: { variantIndex: i, eventType: "conversion" },
    });
    res.push({
      variant: config.recruitment.ctaVariants[i],
      impressions,
      clicks,
      conversions,
      ctr: impressions ? (clicks / impressions) * 100 : 0,
      conversionRate: clicks ? (conversions / clicks) * 100 : 0,
    });
  }
  console.log("A/B Test Results:", res);
}

/* ---------- 10. GPT ANALYSIS ----------------------------- */
async function analyzeMessage(text: string): Promise<AnalyzedMessage | null> {
  try {
    const rsp = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content:
            "Analyze this Telegram message for a crypto bot. Return JSON with: " +
            "isEnglish, sentiment (-1..1), intent (gas_complaint | token_inquiry | defi_question | nft_discussion | general_crypto | off_topic)," +
            "entities.chains, entities.tokens, entities.protocols, keywords.",
        },
        { role: "user", content: text },
      ],
      response_format: { type: "json_object" },
      temperature: 0.2,
    });
    return JSON.parse(rsp.choices[0].message.content!) as AnalyzedMessage;
  } catch (e) {
    console.error("Analyze error:", e);
    return null;
  }
}

/* ---------- 11. BITLY LINK GEN --------------------------- */
async function generateBitlyLink(uid: number, tid: string) {
  try {
    const longUrl = `https://gasguardian.app/invite?uid=${uid}&tid=${tid}`;
    const rsp = await axios.post(
      "https://api-ssl.bitly.com/v4/shorten",
      { long_url: longUrl, domain: "bit.ly" },
      {
        headers: {
          Authorization: `Bearer ${config.api.bitlyToken}`,
          "Content-Type": "application/json",
        },
      }
    );
    return rsp.data.link;
  } catch (e) {
    console.error("Bitly error:", e);
    return `https://gasguardian.app/i/${tid}`;
  }
}

/* ---------- 12. INTERACTION LOGGER ----------------------- */
async function logInteraction(data: {
  userId: number;
  groupId?: number;
  messageId: number;
  eventType: "group_reply" | "dm_reply" | "click" | "onboarding" | "impression";
  trackingId: string;
  source?: DataSourceType;
  variantIndex?: number;
  meta?: Record<string, any>;
}) {
  await prisma[config.db.interactionTable].create({
    data: { ...data, timestamp: new Date() },
  });
}

/* ---------- 13. BETA TESTER REGISTRY --------------------- */
async function canJoinBeta() {
  const count = await prisma[config.db.testerTable].count();
  return count < config.reply.testingLimit;
}
async function registerBetaTester(uid: number, email: string, referrerId?: number) {
  await prisma[config.db.testerTable].create({
    data: { tgUserId: uid, email, referrerId, joinedAt: new Date() },
  });
  if (referrerId)
    await prisma[config.db.referralTable].create({
      data: { referrerId, referredId: uid, timestamp: new Date() },
    });
}
/* ---------- 14. DATA FETCHERS ---------------------------- */
// Fetchers for gas, trending tokens, news, etc. (pseudo-code, replace with your implementations)
async function fetchGasPrices(): Promise<DataInsight[]> {
  // Example: Call Blocknative or another API
  // return [{ text: "ETH gas 12 gwei", source: DataSourceType.BLOCKNATIVE, relevanceScore: 1, timestamp: new Date() }];
  return [];
}
async function fetchTrendingTokens(): Promise<DataInsight[]> {
  // Example: Return trending tokens from Coingecko
  return [];
}
async function fetchNews(): Promise<DataInsight[]> {
  // Example: Return news from CryptoPanic
  return [];
}
async function fetchFundingRates(): Promise<DataInsight[]> {
  // Example: Return funding rates from Coinglass
  return [];
}
async function fetchTrendingDapps(): Promise<DataInsight[]> {
  // Example: Return trending dapps from DappRadar
  return [];
}
async function collectRelevantInsights(msg: AnalyzedMessage): Promise<DataInsight[]> {
  // Call all fetchers, filter/sort based on msg intent & entities
  let insights: DataInsight[] = [];
  insights = insights.concat(await fetchGasPrices());
  insights = insights.concat(await fetchTrendingTokens());
  insights = insights.concat(await fetchNews());
  insights = insights.concat(await fetchFundingRates());
  insights = insights.concat(await fetchTrendingDapps());
  // Sort and filter as needed
  return insights.sort((a, b) => b.relevanceScore - a.relevanceScore).slice(0, 3);
}

/* ---------- 15. REPLY GENERATOR -------------------------- */
async function generateReply(
  e: NewMessageEvent,
  analyzed: AnalyzedMessage,
  insights: DataInsight[],
  group: boolean,
  trackingId: string,
  variantIndex?: number
): Promise<string> {
  let reply = "";
  // Example logic: choose reply based on intent, add insights, keep under maxLength
  if (analyzed.intent === MessageIntentType.GAS_COMPLAINT) {
    reply = "Gas high? Try these tips:";
  } else if (analyzed.intent === MessageIntentType.TOKEN_INQUIRY) {
    reply = "Looking up token info...";
  } else if (analyzed.intent === MessageIntentType.DEFI_QUESTION) {
    reply = "DeFi question? Here are the latest stats:";
  } else if (analyzed.intent === MessageIntentType.NFT_DISCUSSION) {
    reply = "NFTs are hot! Trends:";
  } else if (analyzed.intent === MessageIntentType.GENERAL_CRYPTO) {
    reply = "Crypto update:";
  } else {
    reply = "I'm GasGuardian, your crypto gas assistant.";
  }
  for (const i of insights) {
    if (reply.length + 2 + i.text.length < config.reply.maxLength)
      reply += "\n• " + i.text;
  }
  if (group && typeof variantIndex === "number") {
    reply += `\n\n${config.recruitment.ctaVariants[variantIndex]}`;
  }
  return reply.trim().slice(0, config.reply.maxLength);
}

/* ---------- 16. GROUP & DM HANDLERS ---------------------- */
async function handleGroupMessage(e: NewMessageEvent) {
  const msg = e.message;
  const chatId = Number(msg.peerId?.chatId ?? msg.peerId?.channelId ?? 0);
  if (!(await canReplyInGroup(chatId))) return;
  const analyzed = await analyzeMessage(msg.message);
  if (!analyzed || !analyzed.isEnglish || analyzed.sentiment < config.reply.sentimentThreshold) return;
  const insights = await collectRelevantInsights(analyzed);
  const trackingId = generateTrackingId();
  const variantIndex = chatId % config.recruitment.ctaVariants.length;
  const reply = await generateReply(e, analyzed, insights, true, trackingId, variantIndex);
  await markReplyInGroup(chatId);
  await logInteraction({
    userId: Number(msg.senderId),
    groupId: chatId,
    messageId: msg.id,
    eventType: "group_reply",
    trackingId,
    source: DataSourceType.GPT,
    variantIndex,
    meta: { analyzed, insights },
  });
  await e.reply({ message: reply });
  await logABTest(Number(msg.senderId), variantIndex, "impression");
}

async function handleDirectMessage(e: NewMessageEvent) {
  const msg = e.message;
  const uid = Number(msg.senderId);
  if (!(await canReplyInDM(uid))) return;
  // Owner commands
  if (uid === config.telegram.ownerChat) {
    if (/\/discover_now/i.test(msg.message)) {
      await discoverGroups(client);
      await e.reply({ message: "Discovery triggered." });
      return;
    }
    if (/\/stats/i.test(msg.message)) {
      const stats = await generateOwnerStats();
      await e.reply({ message: stats });
      return;
    }
    if (/\/leaderboard/i.test(msg.message)) {
      const board = await generateReferralLeaderboard();
      await e.reply({ message: board });
      return;
    }
    // ...add more owner commands as needed...
  }
  // Beta onboarding
  if (/\/test/i.test(msg.message)) {
    if (!(await canJoinBeta())) {
      await e.reply({ message: "Sorry, beta slots are full." });
      return;
    }
    await e.reply({ message: config.recruitment.betaInstructions });
    // Wait for email (next message)
    const filter = (ev: NewMessageEvent) =>
      ev.message.senderId === msg.senderId && /\S+@\S+\.\S+/.test(ev.message.message);
    const next = await client.waitForEvent(NewMessage, filter, 60_000);
    if (next) {
      await registerBetaTester(uid, next.message.message.trim());
      await e.reply({ message: config.recruitment.confirmationMessage });
      await logInteraction({
        userId: uid,
        messageId: next.message.id,
        eventType: "onboarding",
        trackingId: generateTrackingId(),
        source: DataSourceType.GPT,
      });
    }
    return;
  }
  // General DM: analyze, reply, record
  const analyzed = await analyzeMessage(msg.message);
  if (!analyzed || !analyzed.isEnglish) return;
  const insights = await collectRelevantInsights(analyzed);
  const trackingId = generateTrackingId();
  const reply = await generateReply(e, analyzed, insights, false, trackingId);
  await markReplyInDM(uid);
  await logInteraction({
    userId: uid,
    messageId: msg.id,
    eventType: "dm_reply",
    trackingId,
    source: DataSourceType.GPT,
    meta: { analyzed, insights },
  });
  await e.reply({ message: reply });
}

/* ---------- 21. SCHEDULE JOBS ---------------------------- */
function setupScheduledJobs(client: TelegramClient) {
  schedule.scheduleJob(config.schedules.discoveryTime, () => discoverGroups(client));
  schedule.scheduleJob(config.schedules.joinTime, () => joinHighlyConvertibleGroups(client));
  schedule.scheduleJob(config.schedules.analyticsTime, async () => {
    const stats = await generateOwnerStats();
    await client.sendMessage(config.telegram.ownerChat, { message: stats });
  });
  schedule.scheduleJob(config.schedules.leaderboardTime, async () => {
    const board = await generateReferralLeaderboard();
    await client.sendMessage(config.telegram.ownerChat, { message: board });
  });
  schedule.scheduleJob("0 0 * * 0", analyzeABTestResults); // weekly test analysis
}

/* ---------- 22. MAIN RUNTIME ----------------------------- */
const client = new TelegramClient(
  new StringSession(config.telegram.session),
  config.telegram.apiId,
  config.telegram.apiHash,
  { connectionRetries: 5 }
);

async function main() {
  await client.start({
    phoneNumber: async () => "",
    password: async () => "",
    phoneCode: async () => "",
    onError: (err) => console.error(err),
  });
  console.log("🚀 GasGuardian userbot started!");

  setupScheduledJobs(client);

  client.addEventHandler(
    async (e: NewMessageEvent) => {
      try {
        const msg = e.message;
        if (msg.out) return;
        if (msg.peerId?.className === "PeerUser") {
          await handleDirectMessage(e);
        } else if (
          msg.peerId?.className === "PeerChat" ||
          msg.peerId?.className === "PeerChannel"
        ) {
          await handleGroupMessage(e);
        }
      } catch (err) {
        console.error("Event handler error:", err);
      }
    },
    new NewMessage({})
  );

  await discoverGroups(client);
}

main().catch(console.error);

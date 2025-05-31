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
  },
  schedules: {
    discoveryTime: "0 */12 * * *",
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
}

/* ---------- 6. UTILITIES --------------------------------- */
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
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
        const chatId = chat.id;
        const title = (chat as any).title as string;
        const username = (chat as any).username as string | undefined;
        const isChannel = !!(chat as any).broadcast;
        const memberCount = (chat as any).participantsCount ?? undefined;
        if (
          config.discovery.blacklistedWords.some((w) => title.toLowerCase().includes(w)) ||
          (memberCount && memberCount < config.discovery.minGroupSize)
        )
          continue;

        await prisma[config.db.discoveredGroupTable].upsert({
          where: { id: chatId },
          update: { lastCheckedAt: new Date(), title, username, memberCount },
          create: {
            id: chatId,
            title,
            username,
            memberCount,
            isChannel,
            discoveredAt: new Date(),
            lastCheckedAt: new Date(),
            keyword: kw,
            isMonitored: false,
          },
        });
        await prisma[config.db.discoveryLogTable].create({
          data: { groupId: chatId, title, keyword: kw, timestamp: new Date(), memberCount },
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
  msg += "\nUse /monitor <group_id> to start monitoring.";
  await client.sendMessage(config.telegram.ownerChat, { message: msg });
}

async function handleOwnerCommands(
  client: TelegramClient,
  uid: number,
  text: string
): Promise<boolean> {
  if (uid !== config.telegram.ownerChat) return false;
  if (text === "/discover_now") {
    await client.sendMessage(uid, { message: "Starting manual discovery…" });
    await discoverGroups(client);
    return true;
  }
  if (text === "/stats") {
    const stats = await generateOwnerStats();
    await client.sendMessage(uid, { message: stats });
    return true;
  }
  if (text.startsWith("/monitor ")) {
    const gid = parseInt(text.split(" ")[1]);
    if (isNaN(gid)) {
      await client.sendMessage(uid, { message: "Invalid group ID" });
      return true;
    }
    await prisma[config.db.discoveredGroupTable].update({
      where: { id: gid },
      data: { isMonitored: true },
    });
    await client.sendMessage(uid, { message: `Group ${gid} is now monitored.` });
    return true;
  }
  if (text === "/leaderboard") {
    const board = await generateReferralLeaderboard();
    await client.sendMessage(uid, { message: board });
    return true;
  }
  return false;
}

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

/* ---------- 9. A/B TESTING HELPERS ----------------------- */
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

/* ---------- 14. DATA FETCHERS (Blocknative, Bitquery, ... ) */
async function fetchGasPrices(chainId: number): Promise<number | null> {
  try {
    const rsp = await axios.get(
      `https://api.blocknative.com/gasprices/blockprices?chainid=${chainId}`,
      { headers: { Authorization: config.api.blocknativeKey } }
    );
    return rsp.data.blockPrices[0]?.estimatedPrices[0]?.price ?? null;
  } catch (e) {
    console.error(`Gas fetch error ${chainId}:`, e);
    return null;
  }
}
async function fetchMempoolData(chainId: number): Promise<DataInsight | null> {
  try {
    const key = `mempool:${chainId}`;
    const cached = await redis.get(key);
    if (cached) return JSON.parse(cached);
    const rsp = await axios.post(
      "https://graphql.bitquery.io",
      {
        query: `
        query {
          ethereum(network: ${
            chainId === 1 ? "ethereum" : chainId === 56 ? "bsc" : "arbitrum"
          }) {
            transactions(options: {limit: 5, desc: "value"}) {
              value
              to { address }
              from { address }
            }
          }
        }`,
      },
      { headers: { "X-API-KEY": config.api.bitqueryKey } }
    );
    const txs = rsp.data.data.ethereum.transactions;
    if (!txs?.length) return null;
    const chain = chains.find((c) => c.id === chainId)!;
    const value = parseFloat(txs[0].value) / 1e18;
    const insight = {
      text: `${chain.emoji} Whale alert: ${value.toFixed(1)} ${chain.symbol} moving on ${chain.name}!`,
      source: DataSourceType.BITQUERY,
      relevanceScore: 0.85,
      timestamp: new Date(),
    };
    await redis.set(key, JSON.stringify(insight), "EX", 300);
    return insight;
  } catch (e) {
    console.error("Mempool error:", e);
    return null;
  }
}
async function fetchTrendingTokens(): Promise<DataInsight | null> {
  try {
    const key = "trending_tokens";
    const cached = await redis.get(key);
    if (cached) return JSON.parse(cached);
    const rsp = await axios.get("https://api.coingecko.com/api/v3/search/trending");
    const top = rsp.data.coins?.slice(0, 3).map((c: any) => c.item.symbol.toUpperCase()).join(", ");
    if (!top) return null;
    const insight = {
      text: `📈 Trending now: ${top}`,
      source: DataSourceType.COINGECKO,
      relevanceScore: 0.8,
      timestamp: new Date(),
    };
    await redis.set(key, JSON.stringify(insight), "EX", 900);
    return insight;
  } catch (e) {
    console.error("Trending token error:", e);
    return null;
  }
}
async function fetchCryptoNews(): Promise<DataInsight | null> {
  try {
    const key = "crypto_news";
    const cached = await redis.get(key);
    if (cached) return JSON.parse(cached);
    const rsp = await axios.get(
      `https://cryptopanic.com/api/v1/posts/?auth_token=${config.api.cryptoPanicKey}&kind=news`
    );
    const news = rsp.data.results?.[0];
    if (!news) return null;
    const insight = {
      text: `📰 Breaking: ${news.title.slice(0, 80)}...`,
      source: DataSourceType.CRYPTOPANIC,
      relevanceScore: 0.7,
      timestamp: new Date(),
    };
    await redis.set(key, JSON.stringify(insight), "EX", 1200);
    return insight;
  } catch (e) {
    console.error("News error:", e);
    return null;
  }
}
async function fetchFundingRates(): Promise<DataInsight | null> {
  try {
    const key = "funding_rates";
    const cached = await redis.get(key);
    if (cached) return JSON.parse(cached);
    const rsp = await axios.get(
      "https://open-api.coinglass.com/api/pro/v1/futures/funding_rates_chart",
      {
        headers: { coinglassSecret: config.api.coinglassKey },
        params: { symbol: "BTC", time_type: "h4" },
      }
    );
    const binanceRate = rsp.data.data?.find((r: any) => r.exchange === "Binance");
    const rate = binanceRate?.uMarginList?.slice(-1)[0];
    if (rate == null) return null;
    const dir = rate > 0 ? "positive" : "negative";
    const insight = {
      text: `💹 BTC funding rate ${dir} at ${Math.abs(rate).toFixed(4)}% on Binance`,
      source: DataSourceType.COINGLASS,
      relevanceScore: 0.75,
      timestamp: new Date(),
    };
    await redis.set(key, JSON.stringify(insight), "EX", 1800);
    return insight;
  } catch (e) {
    console.error("Funding error:", e);
    return null;
  }
}
async function fetchTrendingDapps(): Promise<DataInsight | null> {
  try {
    const key = "trending_dapps";
    const cached = await redis.get(key);
    if (cached) return JSON.parse(cached);
    const rsp = await axios.get("https://api.dappradar.com/4tsxo4vuhotaojtl/dapps", {
      params: { sort: "users-desc", page: 1, resultsPerPage: 5 },
      headers: { "X-API-KEY": config.api.dappRadarKey },
    });
    const dapp = rsp.data.results?.[0];
    if (!dapp) return null;
    const insight = {
      text: `🔥 ${dapp.name} is the hottest dApp with ${dapp.metrics.users_24h.toLocaleString()} users!`,
      source: DataSourceType.DAPPRADAR,
      relevanceScore: 0.7,
      timestamp: new Date(),
    };
    await redis.set(key, JSON.stringify(insight), "EX", 3600);
    return insight;
  } catch (e) {
    console.error("Dapp error:", e);
    return null;
  }
}

/* ---------- 15. INSIGHT COLLECTOR ------------------------ */
async function getRelevantInsights(analysis: AnalyzedMessage): Promise<DataInsight[]> {
  const insights: DataInsight[] = [];
  if (analysis.entities.chains.length) {
    const chainName = analysis.entities.chains[0].toLowerCase();
    const chain = chains.find((c) => c.name.toLowerCase() === chainName);
    if (chain) {
      if (analysis.intent === MessageIntentType.GAS_COMPLAINT) {
        const gas = await fetchGasPrices(chain.id);
        if (gas !== null)
          insights.push({
            text: `${chain.emoji} ${chain.name} gas: ${gas} gwei`,
            source: DataSourceType.BLOCKNATIVE,
            relevanceScore: 0.9,
            timestamp: new Date(),
          });
      }
      const mem = await fetchMempoolData(chain.id);
      if (mem) insights.push(mem);
    }
  }
  if (analysis.entities.tokens.length) {
    const trend = await fetchTrendingTokens();
    if (trend) insights.push(trend);
  }
  if (analysis.intent === MessageIntentType.GENERAL_CRYPTO) {
    const news = await fetchCryptoNews();
    if (news) insights.push(news);
  }
  if (
    analysis.intent === MessageIntentType.TOKEN_INQUIRY ||
    analysis.keywords.includes("trading")
  ) {
    const fr = await fetchFundingRates();
    if (fr) insights.push(fr);
  }
  if (
    analysis.intent === MessageIntentType.DEFI_QUESTION ||
    analysis.intent === MessageIntentType.NFT_DISCUSSION
  ) {
    const dapp = await fetchTrendingDapps();
    if (dapp) insights.push(dapp);
  }
  return insights.sort((a, b) => b.relevanceScore - a.relevanceScore);
}

/* ---------- 16. GPT REPLY GENERATOR ---------------------- */
async function generateReply(a: AnalyzedMessage, insight: DataInsight) {
  try {
    const rsp = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content:
            "You are GasGuardian, a helpful crypto assistant. Create a short, engaging reply " +
            "(≤100 chars) using this crypto insight. Be concise, specific, actionable. No emojis/links.",
        },
        { role: "user", content: `Insight: ${insight.text}. Sentiment: ${a.sentiment}` },
      ],
      max_tokens: 100,
      temperature: 0.7,
    });
    let reply = rsp.choices[0].message.content?.trim() || insight.text;
    if (reply.length > 100) reply = reply.slice(0, 97) + "...";
    return reply;
  } catch (e) {
    console.error("Reply error:", e);
    return insight.text;
  }
}

/* ---------- 17. FINAL REPLY FORMATTER -------------------- */
async function formatFinalReply(
  uid: number,
  reply: string,
  includeCta: boolean
): Promise<{ text: string; trackingId: string; bitlyUrl?: string; variantIndex?: number }> {
  const tid = generateTrackingId();
  let final = reply;
  let bitly: string | undefined;
  let idx: number | undefined;

  if (includeCta) {
    idx = uid % config.recruitment.ctaVariants.length;
    const cta = config.recruitment.ctaVariants[idx];
    bitly = await generateBitlyLink(uid, tid);
    final = `${reply}\n\n${cta} ${bitly}`;
  }
  if (final.length > config.reply.maxLength) final = final.slice(0, config.reply.maxLength - 3) + "...";
  return { text: final, trackingId: tid, bitlyUrl: bitly, variantIndex: idx };
}

/* ---------- 18. GROUP MESSAGE HANDLER -------------------- */
async function handleGroupMessage(event: NewMessageEvent) {
  const m = event.message;
  const text = m.message;
  const chatId = Number(m.peerId.chatId || m.peerId.channelId);
  const fromId = Number(m.fromId?.userId);
  if (!text || !chatId || !fromId) return;
  if (event.message.fromId?.className === "PeerUser" && event.message.fromId?.userId === "bot")
    return;
  if (!(await canReplyInGroup(chatId))) return;
  if (!(await canReplyToUser(fromId))) return;

  const analysis = await analyzeMessage(text);
  if (
    !analysis ||
    !analysis.isEnglish ||
    analysis.sentiment > -0.2 ||
    analysis.intent === MessageIntentType.OFF_TOPIC
  )
    return;

  const insights = await getRelevantInsights(analysis);
  if (!insights.length) return;
  const best = insights[0];
  const reply = await generateReply(analysis, best);
  const showCta = analysis.sentiment < -0.5 && (await canShowCTA(fromId)) && (await canJoinBeta());
  const final = await formatFinalReply(fromId, reply, showCta);

  await client.sendMessage(chatId, { message: final.text, replyTo: m.id });
  await logInteraction({
    userId: fromId,
    groupId: chatId,
    messageId: Number(m.id),
    eventType: "group_reply",
    trackingId: final.trackingId,
    source: best.source,
    variantIndex: final.variantIndex,
    meta: { hasCta: showCta, sentiment: analysis.sentiment, intent: analysis.intent },
  });
  if (showCta && final.variantIndex !== undefined)
    await logABTest(fromId, final.variantIndex, "impression");
  await markReplyInGroup(chatId);
  await markReplyToUser(fromId);
  if (showCta) await markCTAShown(fromId);
}

/* ---------- 19. DIRECT MESSAGE HANDLER ------------------- */
async function handleDirectMessage(event: NewMessageEvent) {
  const m = event.message;
  const text = m.message;
  const uid = Number(m.peerId.userId);
  if (!text || !uid) return;

  if (await handleOwnerCommands(client, uid, text.trim())) return;
  if (!(await canReplyInDM(uid))) return;

  if (text.trim() === "/test" || text.toLowerCase().includes("join beta")) {
    if (await canJoinBeta())
      await client.sendMessage(uid, { message: config.recruitment.betaInstructions });
    else
      await client.sendMessage(uid, {
        message: "Sorry, our beta test is full. We'll notify you when spots open!",
      });
    await logInteraction({
      userId: uid,
      messageId: Number(m.id),
      eventType: "onboarding",
      trackingId: generateTrackingId(),
      meta: { step: "request" },
    });
    await markReplyInDM(uid);
    return;
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (emailRegex.test(text.trim())) {
    const referrerId = await redis.get(`referrer:${uid}`);
    await registerBetaTester(
      uid,
      text.trim(),
      referrerId ? parseInt(referrerId) : undefined
    );
    await client.sendMessage(uid, { message: config.recruitment.confirmationMessage });
    await logInteraction({
      userId: uid,
      messageId: Number(m.id),
      eventType: "onboarding",
      trackingId: generateTrackingId(),
      meta: { email: text.trim(), referrerId: referrerId || null, step: "complete" },
    });
    const variant = await redis.get(`variant:${uid}`);
    if (variant) await logABTest(uid, parseInt(variant), "conversion");
    await markReplyInDM(uid);
    return;
  }

  const analysis = await analyzeMessage(text);
  if (!analysis) {
    await client.sendMessage(uid, {
      message:
        "I'm GasGuardian! Ask about gas prices, trending tokens, or DeFi news.",
    });
    await markReplyInDM(uid);
    return;
  }
  const insights = await getRelevantInsights(analysis);
  if (!insights.length) {
    await client.sendMessage(uid, {
      message:
        "I'm GasGuardian! Ask about gas prices, trending tokens, or DeFi news.",
    });
  } else {
    const best = insights[0];
    await client.sendMessage(uid, { message: best.text });
    await logInteraction({
      userId: uid,
      messageId: Number(m.id),
      eventType: "dm_reply",
      trackingId: generateTrackingId(),
      source: best.source,
    });
  }
  await markReplyInDM(uid);
}

/* ---------- 20. CLICK TRACKING (placeholder) ------------- */
async function processClick(trackingId: string, uid: number) {
  await logInteraction({
    userId: uid,
    messageId: 0,
    eventType: "click",
    trackingId,
  });
  await redis.set(`referrer:${uid}`, uid.toString(), "EX", 604800);
  const variant = await redis.get(`variant:impression:${trackingId}`);
  if (variant) await logABTest(uid, parseInt(variant), "click");
}

/* ---------- 21. SCHEDULE JOBS ---------------------------- */
function setupScheduledJobs(client: TelegramClient) {
  schedule.scheduleJob(config.schedules.discoveryTime, () => discoverGroups(client));
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

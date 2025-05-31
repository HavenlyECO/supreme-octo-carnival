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

// --------------- ENV AND CONFIG ---------------
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
  TGSTAT_KEY: getEnv("TGSTAT_KEY", false), // <-- NEW TGSTAT API KEY
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
    tgstatKey: env.TGSTAT_KEY, // <-- NEW
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
    discoveryTime: "0 2 * * *", // <--- ONCE PER DAY AT 2:00 AM UTC
    joinTime: "10,40 * * * *",
    analyticsTime: "0 0 * * *",
    leaderboardTime: "0 12 * * 1",
    auditTime: "15,45 * * * *",
  }
};

// ----------- ENUMS & TYPES -----------
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
  TGSTAT = "tgstat", // NEW
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

// ----------- CLIENTS -----------
const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
const redis = new Redis(env.REDIS_URL);
const prisma = new PrismaClient();

// ----------- UTILITIES -----------

// --- TGStat Info Utility ---
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const toBigInt = (v: any): bigint => typeof v === "bigint" ? v : BigInt(v);
function isBlacklistedGroup(g: { title?: string; description?: string; username?: string; memberCount?: number }): boolean {
  const badWords = config.discovery.blacklistedWords;
  const text = `${g.title || ""} ${(g.description || "")}`.toLowerCase();
  const hasBad = badWords.some((w) => text.includes(w));
  const userBad = g.username && badWords.some((w) => g.username!.toLowerCase().includes(w));
  const tooSmall = (g.memberCount ?? 999999) < config.discovery.minPublicMemberCount;
  return hasBad || userBad || tooSmall;
}

// --- Redis-based rate limiters ---
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
async function markReplyInGroup(cid: number) { await redis.set(`ratelimit:group:${cid}`, Date.now().toString()); }
async function markReplyToUser(uid: number) { await redis.set(`ratelimit:user:${uid}`, Date.now().toString()); }
async function markReplyInDM(uid: number) { await redis.set(`ratelimit:dm:${uid}`, Date.now().toString()); }

// --- DISCOVERY, JOIN, AUDIT, REMOVE, ADMIN ---
async function discoverGroups(client: TelegramClient) {
  for (const kw of config.discovery.keywords) {
    try {
      const result = await client.invoke(new Api.contacts.Search({ q: kw, limit: config.discovery.maxGroupsPerSearch }));
      for (const chat of result.chats) {
        if (!("title" in chat)) continue;
        const chatIdBig = toBigInt(chat.id);
        const title = (chat as any).title as string;
        const username = (chat as any).username as string | undefined;
        const isChannel = !!(chat as any).broadcast;
        const memberCount = (chat as any).participantsCount ?? undefined;
        const description = (chat as any).about as string | undefined;
        const isBad = isBlacklistedGroup({ title, description, username, memberCount });

        // ---- TGStat Enrichment ----
        let tgstatInfo: any = null;
        if (username) tgstatInfo = await fetchTGStatInfo(username);

        // Exclude broadcast channels with no discussion/comments
        let isDiscussion = true;
        if (tgstatInfo && tgstatInfo.type === 'channel' && !tgstatInfo.linked_chat_id && !tgstatInfo.comments_enabled) {
          isDiscussion = false;
        }

        await prisma.discoveredGroup.upsert({
          where: { id: chatIdBig },
          update: {
            lastCheckedAt: new Date(),
            title,
            username,
            memberCount,
            description,
            isMonitored: false,
            blacklisted: isBad || !isDiscussion,
            autoJoinStatus: (isBad || !isDiscussion) ? "blacklisted" : (isChannel && !!username && memberCount && memberCount >= config.discovery.minPublicMemberCount ? "eligible" : "ineligible"),
          },
          create: {
            id: chatIdBig,
            title,
            username,
            memberCount,
            description,
            isChannel,
            discoveredAt: new Date(),
            lastCheckedAt: new Date(),
            keyword: kw,
            isMonitored: false,
            blacklisted: isBad || !isDiscussion,
            autoJoinStatus: (isBad || !isDiscussion) ? "blacklisted" : (isChannel && !!username && memberCount && memberCount >= config.discovery.minPublicMemberCount ? "eligible" : "ineligible"),
          },
        });
        await prisma.discoveryLog.create({ data: { groupId: chatIdBig, title, keyword: kw, timestamp: new Date(), memberCount } });
      }
      await sleep(60_000); // --- Sleep 1 minute between each keyword ---
    } catch (e) { }
  }
}

async function joinHighlyConvertibleGroups(client: TelegramClient) {
  const candidates = await prisma.discoveredGroup.findMany({
    where: {
      isChannel: true,
      username: { not: null },
      memberCount: { gte: config.discovery.minPublicMemberCount },
      autoJoinStatus: "eligible",
      isMonitored: false,
      blacklisted: false,
    },
    orderBy: { memberCount: "desc" },
    take: config.discovery.autoJoinLimit,
  });
  for (const group of candidates) {
    if (isBlacklistedGroup(group)) {
      await prisma.discoveredGroup.update({
        where: { id: toBigInt(group.id) },
        data: { blacklisted: true, removalReason: "Auto-join: Detected as blacklisted" },
      });
      continue;
    }
    // --- Remove broadcast-only channels (TGStat check) ---
    let tgstatInfo: any = null;
    if (group.username) tgstatInfo = await fetchTGStatInfo(group.username);
    if (tgstatInfo && tgstatInfo.type === 'channel' && !tgstatInfo.linked_chat_id && !tgstatInfo.comments_enabled) {
      await prisma.discoveredGroup.update({
        where: { id: toBigInt(group.id) },
        data: { blacklisted: true, removalReason: "Auto-join: Broadcast-only (no discussion/comments)" },
      });
      continue;
    }
    try {
      await client.invoke(new Api.channels.JoinChannel({ channel: group.username!.startsWith("@") ? group.username : `@${group.username}` }));
      await prisma.discoveredGroup.update({
        where: { id: toBigInt(group.id) },
        data: {
          isMonitored: true,
          autoJoinStatus: "joined",
        },
      });
      await prisma.monitoredGroup.upsert({
        where: { id: toBigInt(group.id) },
        create: { id: toBigInt(group.id), joinedAt: new Date(), group: { connect: { id: toBigInt(group.id) } } },
        update: { lastActive: new Date() }
      });
      await sleep(2000);
    } catch (err) {
      await prisma.discoveredGroup.update({ where: { id: toBigInt(group.id) }, data: { autoJoinStatus: "failed" } });
    }
  }
}

async function autoRemoveGroup(client: TelegramClient, groupId: bigint | number, reason: string, initiatorId?: number) {
  const group = await prisma.discoveredGroup.findUnique({ where: { id: BigInt(groupId) } });
  if (!group) return;
  try {
    if (group.username) await client.invoke(new Api.channels.LeaveChannel({ channel: group.username.startsWith("@") ? group.username : "@" + group.username }));
  } catch {}
  await prisma.discoveredGroup.update({
    where: { id: BigInt(groupId) },
    data: { blacklisted: true, removalReason: reason, isMonitored: false },
  });
  await prisma.groupRemovalLog.create({
    data: {
      groupId: BigInt(groupId),
      removedAt: new Date(),
      reason,
      initiatorId,
      groupTitle: group.title,
      username: group.username,
    }
  });
  if (reason && client && config.telegram.ownerChat) {
    await client.sendMessage(config.telegram.ownerChat, {
      message: `🚫 Left & blacklisted: ${group.title} (${group.username || group.id})\nReason: ${reason}`
    });
  }
}

// --- AUTO AUDIT W/ TGSTAT ---
async function autoAuditGroups(client: TelegramClient) {
  const joined = await prisma.discoveredGroup.findMany({ where: { isMonitored: true, blacklisted: false }, orderBy: { memberCount: "asc" } });
  for (const g of joined) {
    // --- TGStat: Remove dead/discussion-disabled groups ---
    let tgstatInfo: any = null;
    if (g.username) tgstatInfo = await fetchTGStatInfo(g.username);
    if (isBlacklistedGroup(g) ||
        (tgstatInfo && tgstatInfo.type === 'channel' && !tgstatInfo.linked_chat_id && !tgstatInfo.comments_enabled) ||
        (tgstatInfo && tgstatInfo.members_count < config.discovery.minPublicMemberCount) ||
        (tgstatInfo && tgstatInfo.growth_7d < 1)
    ) {
      await autoRemoveGroup(client, g.id, "Auto-audit: Dead, no comments, or TGStat flagged");
    }
  }
}

// --- SCHEDULED JOBS ---
function setupScheduledJobs(client: TelegramClient) {
  schedule.scheduleJob(config.schedules.discoveryTime, () => discoverGroups(client));
  schedule.scheduleJob(config.schedules.joinTime, () => joinHighlyConvertibleGroups(client));
  schedule.scheduleJob(config.schedules.auditTime, () => autoAuditGroups(client));
}

// --- MAIN RUNTIME ---
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
  setupScheduledJobs(client);
  client.addEventHandler(
    async (e: NewMessageEvent) => {
      try {
        const msg = e.message;
        if (msg.out) return;
        if (msg.peerId?.className === "PeerUser") {
          if (msg.senderId == config.telegram.ownerChat) {
            if (/^\/blacklist (\d+)/i.test(msg.message)) {
              const groupId = BigInt(msg.message.match(/^\/blacklist (\d+)/i)![1]);
              await autoRemoveGroup(client, groupId, "Owner Blacklist Command", Number(msg.senderId));
              await e.reply({ message: `Group ${groupId} blacklisted and left.` });
              return;
            }
            if (/^\/audit_now/i.test(msg.message)) {
              await autoAuditGroups(client);
              const groups = await prisma.discoveredGroup.findMany({
                where: { isMonitored: true, blacklisted: false },
                orderBy: { memberCount: "desc" },
                take: 10,
              });
              let msgTxt = `🧹 Audit complete. Currently monitored (top 10 by size):\n`;
              for (const g of groups) {
                msgTxt += `• ${g.title} (${g.username || g.id}) ~${g.memberCount || 0}\n`;
              }
              await e.reply({ message: msgTxt });
              return;
            }
          }
        }
      } catch (err) { }
    },
    new NewMessage({})
  );
  await discoverGroups(client);
}
main().catch(console.error);

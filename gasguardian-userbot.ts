// gasguardian.ts
import * as path from "path";
import { config as dotenvConfig } from "dotenv";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { Api } from "telegram";
import { NewMessage, NewMessageEvent } from "telegram/events";
import OpenAI from "openai";
import axios from "axios";
import Redis from "ioredis";
import { PrismaClient } from "@prisma/client";
import { DateTime } from "luxon";
import * as crypto from "crypto";
import schedule from "node-schedule";

// --- ENV SETUP ---
dotenvConfig({ path: path.resolve(process.cwd(), ".env") });
function getEnv(name: string, required: boolean = true): string {
  const realKey = Object.keys(process.env).find(
    (k) => k.trim().replace(/^\uFEFF/, "") === name
  );
  const value = realKey ? process.env[realKey] : undefined;
  if (required && (!value || value.trim() === "")) throw new Error(`[GasGuardian] Missing required env var → ${name}`);
  return value ? value.trim() : "";
}

// --- CONFIG (Add/adjust as needed) ---
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
    ctaCooldownHours: 24,
    sentimentThreshold: 0.6,
    testingLimit: 100,
  },
  recruitment: {
    ctaVariants: [
      "DM me '/test' for VIP beta access (limited spots)!",
      "Want early access? DM '/test' to join our beta!",
      "Gas bothering you? DM '/test' for our solution's beta.",
      "Join 100 exclusive testers: DM '/test' now.",
    ],
    betaInstructions: "You're in! We'll whitelist your email for the GasGuardian Android beta. Please reply with your Gmail address.",
    confirmationMessage: "Thanks! You're now on our VIP beta list. You'll receive an invite within 24h. Early access, priority support, and gas refunds await!",
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
    blacklistedWords: ["scam", "porn", "betting", "gambling"],
    minPublicMemberCount: 500,
    autoJoinLimit: 2,
  },
  schedules: {
    discoveryTime: "*/1 * * * *",
    joinTime: "10,40 * * * *",
    analyticsTime: "0 0 * * *",
    leaderboardTime: "0 12 * * 1",
  },
};

// --- INIT CLIENTS ---
const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
const redis = new Redis(env.REDIS_URL);
const prisma = new PrismaClient();

// --- UTILITIES ---
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const toBigInt = (v: any): bigint => typeof v === "bigint" ? v : BigInt(v.toString());

function isBlacklistedGroup(g: { title?: string; description?: string; username?: string; memberCount?: number }): boolean {
  const badWords = [
    ...config.discovery.blacklistedWords,
    "giveaway", "casino", "bonus", "pump", "moon", "hacking",
    "porn", "xxx", "sex", "bet", "gamble", "double your", "mlm",
    "signal", "robot", "pump", "spam"
  ];
  const text = `${g.title || ""} ${(g.description || "")}`.toLowerCase();
  const hasBad = badWords.some((w) => text.includes(w));
  const userBad = g.username && badWords.some((w) => g.username!.toLowerCase().includes(w));
  const tooSmall = (g.memberCount ?? 999999) < config.discovery.minPublicMemberCount;
  return hasBad || userBad || tooSmall;
}

// --- GROUP AUDIT/REMOVE ---
async function autoAuditGroups(client: TelegramClient) {
  const joined = await prisma.discoveredGroup.findMany({ where: { isMonitored: true, blacklisted: false }, orderBy: { memberCount: "asc" } });
  for (const g of joined) {
    if (isBlacklistedGroup(g)) await autoRemoveGroup(client, g.id, "Auto-audit: Blacklist/Size/Spam detected");
  }
}

async function autoRemoveGroup(client: TelegramClient, groupId: bigint | number, reason: string, initiatorId?: number) {
  const group = await prisma.discoveredGroup.findUnique({ where: { id: BigInt(groupId) } });
  if (!group) return;
  try {
    if (group.username) await client.invoke(new Api.channels.LeaveChannel({ channel: group.username.startsWith("@") ? group.username : "@" + group.username }));
  } catch (err) {}
  await prisma.discoveredGroup.update({ where: { id: BigInt(groupId) }, data: { blacklisted: true, removalReason: reason, isMonitored: false } });
  await prisma.groupRemovalLog.create({
    data: {
      groupId: BigInt(groupId),
      removedAt: new Date(),
      reason,
      initiatorId,
      groupTitle: group.title,
      username: group.username
    }
  });
  if (reason && client && config.telegram.ownerChat) {
    await client.sendMessage(config.telegram.ownerChat, {
      message: `🚫 Left & blacklisted: ${group.title} (${group.username || group.id})\nReason: ${reason}`
    });
  }
}

// --- JOIN LOGIC ---
async function joinHighlyConvertibleGroups(client: TelegramClient) {
  const candidates = await prisma.discoveredGroup.findMany({
    where: { isChannel: true, username: { not: null }, memberCount: { gte: config.discovery.minPublicMemberCount }, autoJoinStatus: "eligible", isMonitored: false, blacklisted: false },
    orderBy: { memberCount: "desc" },
    take: config.discovery.autoJoinLimit
  });
  for (const group of candidates) {
    if (isBlacklistedGroup(group)) {
      await prisma.discoveredGroup.update({ where: { id: toBigInt(group.id) }, data: { blacklisted: true, removalReason: "Auto-join: Detected as blacklisted" } });
      continue;
    }
    try {
      await client.invoke(new Api.channels.JoinChannel({ channel: group.username!.startsWith("@") ? group.username : `@${group.username}` }));
      await prisma.discoveredGroup.update({ where: { id: toBigInt(group.id) }, data: { isMonitored: true, autoJoinStatus: "joined" } });
      await prisma.monitoredGroup.upsert({
        where: { id: toBigInt(group.id) },
        create: { id: toBigInt(group.id), joinedAt: new Date(), group: { connect: { id: toBigInt(group.id) } } },
        update: { lastActive: new Date() }
      });
      console.log(`[Auto-Join] Joined & monitoring: @${group.username} (${group.id})`);
      await sleep(2000);
    } catch (err) {
      await prisma.discoveredGroup.update({ where: { id: toBigInt(group.id) }, data: { autoJoinStatus: "failed" } });
      console.warn(`[Auto-Join] Failed to join @${group.username}:`, err);
    }
  }
}

// --- DISCOVERY LOGIC ---
async function discoverGroups(client: TelegramClient) {
  console.log(`[${new Date().toISOString()}] Starting group discovery…`);
  let total = 0;
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
        const isBad = isBlacklistedGroup({ title, description: (chat as any).about, username, memberCount });
        await prisma.discoveredGroup.upsert({
          where: { id: chatIdBig },
          update: {
            lastCheckedAt: new Date(),
            title,
            username,
            memberCount,
            isMonitored: false,
            blacklisted: isBad,
            autoJoinStatus: isBad ? "blacklisted" : (isChannel && !!username && memberCount && memberCount >= config.discovery.minPublicMemberCount ? "eligible" : "ineligible"),
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
            blacklisted: isBad,
            autoJoinStatus: isBad ? "blacklisted" : (isChannel && !!username && memberCount && memberCount >= config.discovery.minPublicMemberCount ? "eligible" : "ineligible"),
          },
        });
        await prisma.discoveryLog.create({ data: { groupId: chatIdBig, title, keyword: kw, timestamp: new Date(), memberCount } });
        total++;
      }
      await sleep(2000);
    } catch (e) {
      console.error(`Discovery error for '${kw}':`, e);
    }
  }
  console.log(`[${new Date().toISOString()}] Discovery complete – ${total} groups`);
  // ...send report logic if needed...
}

// --- SCHEDULED JOBS ---
function setupScheduledJobs(client: TelegramClient) {
  schedule.scheduleJob(config.schedules.discoveryTime, () => discoverGroups(client));
  schedule.scheduleJob(config.schedules.joinTime, () => joinHighlyConvertibleGroups(client));
  schedule.scheduleJob("15,45 * * * *", () => autoAuditGroups(client)); // audit every 30min
  // ...other schedules...
}

// --- MAIN ---
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
        // Add logic for DMs (onboarding, owner commands) and group messages as needed
      } catch (err) {
        console.error("Event handler error:", err);
      }
    },
    new NewMessage({})
  );
  await discoverGroups(client);
}
main().catch(console.error);

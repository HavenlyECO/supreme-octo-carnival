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
// ... (unchanged, as in your repo) ...

/* ---------- 6. UTILITIES --------------------------------- */
// ... (unchanged, as in your repo) ...

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
// ... (all your analytics, A/B test, fetchers, handlers, and logic remain unchanged) ...

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

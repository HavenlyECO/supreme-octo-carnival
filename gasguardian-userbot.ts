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
import schedule from "node-schedule";
import { DateTime } from "luxon";
import * as crypto from "crypto";

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
    betaInstructions: "You're in! Reply with your Gmail address.",
    confirmationMessage: "Thanks! You'll get an invite within 24h.",
  },
  discovery: {
    keywords: [
      "gas", "eth", "ethereum", "defi", "nft", "crypto", "blockchain",
      "airdrop", "layer2", "degen", "token", "polygon", "arbitrum",
      "optimism", "base", "solana", "trading", "yield", "staking",
    ],
    maxGroupsPerSearch: 15,
    blacklistedWords: [
      "scam", "porn", "betting", "gambling", "giveaway", "casino", "bonus", "pump", "moon", "hacking",
      "xxx", "sex", "bet", "gamble", "mlm", "signal", "robot", "spam"
    ],
    minPublicMemberCount: 500,
    autoJoinLimit: 2,
  },
  schedules: {
    discoveryTime: "*/1 * * * *", // every 1 minute
    joinTime: "10,40 * * * *",    // every 30 minutes
    analyticsTime: "0 0 * * *",
    leaderboardTime: "0 12 * * 1",
    auditTime: "15,45 * * * *",
  },
  db: {
    testerTable: "BetaTester",
    interactionTable: "Interaction",
    referralTable: "Referral",
    groupTable: "MonitoredGroup",
    discoveredGroupTable: "DiscoveredGroup",
    discoveryLogTable: "DiscoveryLog",
    abTestTable: "AbTestResult",
  }
};

// ----------- CLIENTS -----------
const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
const redis = new Redis(env.REDIS_URL);
const prisma = new PrismaClient();

// ----------- UTILITIES -----------
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

// ------------- GROUP DISCOVERY, JOIN, AUDIT, REMOVE -------------
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
        const description = (chat as any).about as string | undefined;
        const isBad = isBlacklistedGroup({ title, description, username, memberCount });

        await prisma.discoveredGroup.upsert({
          where: { id: chatIdBig },
          update: {
            lastCheckedAt: new Date(),
            title,
            username,
            memberCount,
            description,
            isMonitored: false,
            blacklisted: isBad,
            autoJoinStatus: isBad ? "blacklisted" : (isChannel && !!username && memberCount && memberCount >= config.discovery.minPublicMemberCount ? "eligible" : "ineligible"),
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
            blacklisted: isBad,
            autoJoinStatus: isBad ? "blacklisted" : (isChannel && !!username && memberCount && memberCount >= config.discovery.minPublicMemberCount ? "eligible" : "ineligible"),
          },
        });
        await prisma.discoveryLog.create({
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
    try {
      await client.invoke(
        new Api.channels.JoinChannel({
          channel: group.username!.startsWith("@") ? group.username : `@${group.username}`,
        })
      );
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
      console.log(`[Auto-Join] Joined & monitoring: @${group.username} (${group.id})`);
      await sleep(2000);
    } catch (err) {
      await prisma.discoveredGroup.update({
        where: { id: toBigInt(group.id) },
        data: { autoJoinStatus: "failed" },
      });
      console.warn(`[Auto-Join] Failed to join @${group.username}:`, err);
    }
  }
}

async function autoRemoveGroup(client: TelegramClient, groupId: bigint | number, reason: string, initiatorId?: number) {
  const group = await prisma.discoveredGroup.findUnique({ where: { id: BigInt(groupId) } });
  if (!group) return;
  try {
    if (group.username) {
      await client.invoke(new Api.channels.LeaveChannel({ channel: group.username.startsWith("@") ? group.username : "@" + group.username }));
    }
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

async function autoAuditGroups(client: TelegramClient) {
  const joined = await prisma.discoveredGroup.findMany({
    where: { isMonitored: true, blacklisted: false },
    orderBy: { memberCount: "asc" },
  });
  for (const g of joined) {
    if (isBlacklistedGroup(g)) {
      await autoRemoveGroup(client, g.id, "Auto-audit: Blacklist/Size/Spam detected");
    }
  }
}

// ------------- SCHEDULE JOBS -------------
function setupScheduledJobs(client: TelegramClient) {
  schedule.scheduleJob(config.schedules.discoveryTime, () => discoverGroups(client));
  schedule.scheduleJob(config.schedules.joinTime, () => joinHighlyConvertibleGroups(client));
  schedule.scheduleJob(config.schedules.auditTime, () => autoAuditGroups(client));
  // ... add analytics & leaderboard jobs as needed ...
}

// ------------- MAIN RUNTIME -------------
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
          // Owner blacklist/audit commands (as shown in previous snippets)
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
            // ...other admin commands here...
          }
          // ...other DM handler logic...
        }
        // ...group message handler logic...
      } catch (err) {
        console.error("Event handler error:", err);
      }
    },
    new NewMessage({})
  );

  await discoverGroups(client);
}

main().catch(console.error);

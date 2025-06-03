// gasguardian-userbot.ts
// GasGuardian Disruptive Recruitment Userbot (Updated 06/05/2025 with Improvements)
// ➤ 30-minute “discover” (scrape + enqueue) + 30-minute “join/reply” cycle
// ➤ Improved error handling with exponential backoff for network requests
// ➤ Batched Redis operations for enqueue/dequeue performance
// ➤ Added “global” Telegram API discovery (contacts.Search) for trending channels
// ➤ Enhanced AI reply caching and prompt optimization
// ➤ Personalized and urgent CTA variants with A/B testing hooks
// ➤ Refined DM funnel wording to boost conversions
// ➤ Scheduling adjustments: scrape every 30 minutes, process queue every 30 minutes

import * as path from "path";
import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: path.resolve(process.cwd(), ".env") });

import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions";
import { NewMessage, NewMessageEvent } from "telegram/events";
import OpenAI from "openai";
import axios, { AxiosError } from "axios";
import * as cheerio from "cheerio";
import Redis from "ioredis";
import { PrismaClient } from "@prisma/client";
import schedule from "node-schedule";

// ----------------------------------------
// === ENVIRONMENT & CONFIGURATION  ======
// ----------------------------------------

function getEnv(name: string, required = true): string {
  const realKey = Object.keys(process.env).find((k) =>
    k.trim().replace(/^\uFEFF/, "") === name
  );
  const value = realKey ? process.env[realKey] : undefined;
  if (required && (!value || value.trim() === "")) {
    throw new Error(`[GasGuardian] Missing required env var → ${name}`);
  }
  return value ? value.trim() : "";
}

const env = {
  TG_API_ID: Number(getEnv("TG_API_ID")),
  TG_API_HASH: getEnv("TG_API_HASH"),
  TG_SESSION: getEnv("TG_SESSION"),
  OPENAI_API_KEY: getEnv("OPENAI_API_KEY"),
  TGSTAT_SEARCH_KEY: getEnv("TGSTAT_SEARCH_KEY"),
  REDIS_URL: getEnv("REDIS_URL", false) || "",
  DATABASE_URL: getEnv("DATABASE_URL", false),
};

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
const redis = env.REDIS_URL ? new Redis(env.REDIS_URL) : null;
const prisma = new PrismaClient();

const client = new TelegramClient(
  new StringSession(env.TG_SESSION),
  env.TG_API_ID,
  env.TG_API_HASH,
  { connectionRetries: 5 }
);

// ----------------------------------------
// === GENERAL BOT CONFIGURATION   =======
// ----------------------------------------

const SENSITIVE_WORDS = [
  "support",
  "official",
  "news",
  "admin",
  "rules",
  "report",
  "appeal",
  "tgstat",
  "moderator",
];
const SENSITIVE_REGEX = new RegExp(`\\b(?:${SENSITIVE_WORDS.join("|")})\\b`, "i");
const GROUP_JOIN_WAIT_MIN = 3; // minutes to wait after joining before posting
const DM_REMINDER_MIN = 30; // minutes before DM follow-up

/**
 * Trigger keywords in English and Russian to capture relevant groups.
 */
const RELEVANT_KEYWORDS = [
  // English
  "gas",
  "ethereum",
  "eth",
  "polygon",
  "gas fees",
  "defi",
  "transaction",
  "fee",
  "arbitrum",
  "optimism",
  "l2",
  "zksync",
  "starknet",
  "gas optimization",
  "eth gas tracker",
  "cheap gas",
  "gas price",
  "gas monitor",
  "gas analyzer",
  // Russian
  "газ",
  "газовые комиссии",
  "газ эфириум",
  "экономия газа",
  "низкие комиссии",
  "дефи",
  "эфириум",
  "газ трекер",
  "газ прайс",
  "дешевый газ",
  "газ монитор",
  "алгоритм оптимизации",
];

/**
 * CTA variants (including urgent wording for A/B testing).
 */
const CTA_VARIANTS = [
  "Hmu if you need more help with gas fees! 😊",
  "Let me know if I can help more with gas optimization!",
  "Feel free to DM if gas fees are still bothering you!",
  "🚨 Limited time: Type /test to get access to exclusive low-gas tips!",
  "🔔 Hey there! Complete /test now to claim your personalized gas refund offer!"
];

const config = {
  telegram: {
    apiId: env.TG_API_ID,
    apiHash: env.TG_API_HASH,
    session: env.TG_SESSION,
  },
  recruitment: {
    // Refined DM funnel wording and UGC prompt
    ctaGenericVariants: CTA_VARIANTS,
    betaInstructions:
      "You're in! Please reply with your Gmail address to join GasGuardian's Android beta on Google Play.\n\n" +
      "Вы в деле! Пришлите свою почту Gmail, чтобы попасть в Android-бету GasGuardian.",
    confirmation:
      "Thanks! You'll get an invite within 24-48 hours. Check your email soon for the beta testing invite.\n\n" +
      "Спасибо! В течение 24-48 часов получите приглашение на тест. Проверьте свою почту.",
    ugcPrompt:
      "Love GasGuardian? Share a screenshot, tweet, or feedback in this chat to unlock bonus rewards! 😎",
  },
  discovery: {
    // Adjusted scrape frequency to 30 minutes
    minMembers: 200,
    maxScrapePerRun: 50, // reduce number per run to minimize load
    maxJoinPerRun: 30,
    blacklist: [
      "casino",
      "scam",
      "bet",
      "giveaway",
      "xxx",
      "spam",
      "hack",
      "nude",
      "adult",
      "forex",
      "porn",
      "signal",
      "copytrade",
      "казино",
      "скам",
      "бет",
      "розыгрыш",
      "спам",
      "взлом",
      "ню",
      "взрослый",
      "сигнал",
      "порн",
      "форекс",
    ],
    fallbackBase: 1,
    fallbackMaxTries: 3,
    candidateQueueKey: "candidatesToJoin",
    // Keywords to search globally via Telegram API
    globalSearchKeywords: ["gas", "ethereum", "defi", "crypto", "газ", "эфириум"],
  },
};

// ----------------------------------------
// === CACHES & FALLBACKS ================
// ----------------------------------------

// In-memory fallback for group reply timestamps if Redis is not available
const groupReplyTimestamps: { [key: string]: number } = {};
// In-memory fallback for group join timestamps if Redis is not available
const joinTimestamps: { [key: string]: number } = {};
// In-memory hourly counters for summary
let joinCountHour = 0;
let aiReplyCountHour = 0;
let ctaSentCountHour = 0;
let conversionCountHour = 0;

// Simple in-memory cache for AI replies to reduce redundant API calls
const aiReplyCache = new Map<string, string>();

// ----------------------------------------
// === UTILITY / THROTTLING  FUNCTIONS  ==
// ----------------------------------------

/** Sleep for a randomized interval between min–max milliseconds. */
function sleep(minMs: number, maxMs: number): Promise<void> {
  const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((res) => setTimeout(res, delay));
}

/**
 * Exponential backoff wrapper for async functions that may fail due to network errors.
 * Retries `fn` up to `maxRetries` times with base delay `baseMs`.
 */
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseMs: number = 500
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt > maxRetries) {
        throw err;
      }
      const delay = baseMs * Math.pow(2, attempt - 1) + Math.random() * 200;
      console.warn(`[Backoff] Attempt ${attempt} failed: ${(err as any).message}. Retrying in ${Math.round(delay)}ms.`);
      await new Promise((res) => setTimeout(res, delay));
    }
  }
}

/**
 * Check if we can send a reply in this group today.
 * We track per-day set "repliedGroups:<YYYY-MM-DD>" in Redis.
 */
async function canReplyGroup(groupId: number): Promise<boolean> {
  const key = `repliedGroups:${new Date().toISOString().slice(0, 10)}`;
  if (redis) {
    const isMember = await redis.sismember(key, groupId.toString());
    return isMember === 0;
  }
  // Fallback: allow only one reply per hour as before
  const grpKey = `grp:${groupId}`;
  const last = groupReplyTimestamps[grpKey];
  return !last || Date.now() - last > 60 * 60 * 1000;
}

/**
 * Record that we've replied in this group today.
 */
async function recordGroupReply(groupId: number) {
  const key = `repliedGroups:${new Date().toISOString().slice(0, 10)}`;
  if (redis) {
    await redis.sadd(key, groupId.toString());
    // Set TTL of 25 hours to expire next day
    await redis.expire(key, 25 * 60 * 60);
  } else {
    groupReplyTimestamps[`grp:${groupId}`] = Date.now();
  }
}

/** Check if we have recently joined this group (waiting period). */
async function recentlyJoinedGroup(groupId: number): Promise<boolean> {
  const key = `join:${groupId}`;
  if (redis) {
    const ttl = await redis.ttl(key);
    return ttl > 0; // still in wait period
  }
  const last = joinTimestamps[key];
  return !!last && Date.now() - last < GROUP_JOIN_WAIT_MIN * 60 * 1000;
}

/** Record that we just joined this group. */
function recordJoinGroup(groupId: number) {
  const key = `join:${groupId}`;
  if (redis) {
    redis.set(key, `${Date.now()}`, "EX", GROUP_JOIN_WAIT_MIN * 60);
  } else {
    joinTimestamps[key] = Date.now();
  }
  joinCountHour++;
}

/** Check if a group has been manually left (so we don’t rejoin). */
async function hasLeftGroup(groupId: number): Promise<boolean> {
  const key = `leftGroups`;
  if (redis) {
    return (await redis.sismember(key, groupId.toString())) === 1;
  }
  return false;
}

/** Record that we just left this group (so we don’t rejoin). */
async function recordLeftGroup(groupId: number) {
  const key = `leftGroups`;
  if (redis) {
    await redis.sadd(key, groupId.toString());
  }
}

/**
 * Safely send a message, catching CHAT_ADMIN_REQUIRED and other errors,
 * and logging any unexpected errors.
 */
async function safeSendMessage(
  peer: Api.TypeInputPeer | string,
  text: string,
  replyToId?: number
): Promise<boolean> {
  try {
    await client.sendMessage(peer, {
      message: text,
      ...(replyToId ? { replyTo: replyToId } : {}),
    });
    return true;
  } catch (e: any) {
    const msg = e.errorMessage || e.message || "";
    if (msg.includes("CHAT_ADMIN_REQUIRED")) {
      console.warn("[SAFE SEND] Skipping send: not an admin in this chat.");
      return false;
    }
    console.error("[SAFE SEND] Unexpected error sending message:", msg);
    return false;
  }
}

/**
 * After joining a channel, test if we can post there by sending a
 * small test message and then deleting it. If it fails, return false.
 */
async function testSendAndValidate(inputChan: Api.InputChannel): Promise<boolean> {
  try {
    const testMsg = await client.sendMessage(inputChan, { message: "🛠 Test message" });
    try {
      await client.invoke(
        new Api.messages.DeleteMessages({
          revoke: false,
          id: [testMsg.id],
        })
      );
    } catch {
      // If delete fails, ignore
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Given a username (e.g. "eth_gas_tracker") or numeric channel ID,
 * return an Api.InputChannel (with accessHash) so we can post or leave.
 */
async function getInputChannel(
  usernameOrId: string,
  numericId: number
): Promise<Api.InputChannel | null> {
  try {
    let entity: any;
    if (/^[0-9]+$/.test(usernameOrId)) {
      // It's numeric: try by ID
      entity = await client.getEntity(numericId);
    } else {
      // It's a username string
      const handle = usernameOrId.startsWith("@") ? usernameOrId : "@" + usernameOrId;
      entity = await client.getEntity(handle);
    }
    if (entity instanceof Api.Channel) {
      return new Api.InputChannel({
        channelId: entity.id,
        accessHash: entity.accessHash!,
      });
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Fetch the last N messages from a channel (using GetHistory).
 * Returns an array of text strings (skip messages without text).
 */
async function fetchRecentMessages(
  inputChan: Api.InputChannel,
  limit: number = 20
): Promise<string[]> {
  try {
    const history = await client.invoke(
      new Api.messages.GetHistory({
        peer: inputChan,
        limit,
        offsetDate: 0,
        offsetId: 0,
        maxId: 0,
        minId: 0,
        addOffset: 0,
        hash: Api.BigInteger.fromValue(0),
      })
    );
    const msgs = (history as any).messages as Api.Message[];
    return msgs
      .filter((m) => typeof (m as any).message === "string")
      .map((m) => (m as any).message as string);
  } catch {
    return [];
  }
}

/**
 * Returns `true` if any of the given `messages` contains at least
 * one of our RELEVANT_KEYWORDS (case-insensitive).
 */
function containsRelevantKeyword(messages: string[]): boolean {
  const lowerMsgs = messages.map((t) => t.toLowerCase());
  for (const msg of lowerMsgs) {
    for (const kw of RELEVANT_KEYWORDS) {
      if (msg.includes(kw.toLowerCase())) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Pick the single most recent “relevant” message from `messages`.
 * If none match, return null.
 */
function pickMostRelevantMessage(messages: string[]): string | null {
  for (const text of messages) {
    for (const kw of RELEVANT_KEYWORDS) {
      if (text.toLowerCase().includes(kw.toLowerCase())) {
        return text;
      }
    }
  }
  return null;
}

/**
 * Optimize the prompt size by trimming context and removing extraneous details.
 */
function optimizePrompt(message: string): string {
  // For simplicity, just truncate very long messages to 200 characters
  if (message.length > 200) {
    return message.slice(-200);
  }
  return message;
}

/**
 * Ask OpenAI to generate a concise, context‐driven reply to the given `promptText`.
 * Uses caching to avoid redundant API calls.
 */
async function generateAIReply(
  promptText: string,
  isRussian: boolean,
  userMsgLength: number
): Promise<string> {
  const cacheKey = `${isRussian ? "ru" : "en"}|${promptText}`;
  if (aiReplyCache.has(cacheKey)) {
    return aiReplyCache.get(cacheKey)!;
  }

  const optimized = optimizePrompt(promptText);
  let systemPrompt: string;
  if (isRussian) {
    systemPrompt =
      "Ты бот, который внимательно читает чат и отвечает по теме. Если обсуждают высокие комиссии, дай совет, как их снизить. Не упоминай GasGuardian сразу, только если это действительно поможет. Старайся писать в стиле участника группы.";
  } else {
    systemPrompt =
      "You are a context‐aware assistant that carefully reads the chat and replies topically. If people are discussing high gas fees, give a genuine tip on how to lower fees. Don’t mention GasGuardian up front—only if it truly fits. Match the tone/length of the original message.";
  }

  const userPrompt = isRussian
    ? `Последнее сообщение: "${optimized}"\nНапиши короткий, дружелюбный ответ, соответствующий длине: не более ${
        userMsgLength < 5 ? "5 слов" : "15 слов"
      }${userMsgLength < 5 ? ", очень неформально" : ""}.`
    : `Last message: "${optimized}"\nWrite a short, friendly reply matching the length: no more than ${
        userMsgLength < 5 ? "5 words" : "15 words"
      }${userMsgLength < 5 ? ", keep it super casual" : ""}.`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: userMsgLength < 5 ? 30 : 60,
      temperature: 0.7,
    });
    const reply = response.choices?.[0]?.message?.content?.trim() || "";
    aiReplyCountHour++;
    aiReplyCache.set(cacheKey, reply);
    // Purge cache if too large
    if (aiReplyCache.size > 500) {
      const firstKey = aiReplyCache.keys().next().value;
      aiReplyCache.delete(firstKey);
    }
    return reply;
  } catch (e) {
    console.error("[AI REPLY] Error generating reply:", (e as any).message || e);
    return "";
  }
}

/**
 * Randomly pick one of the CTA variants (with A/B test hook).
 */
function pickRandomCTA(username?: string): string {
  const variant = CTA_VARIANTS[Math.floor(Math.random() * CTA_VARIANTS.length)];
  if (username) {
    // Personalize by mentioning the username if available
    return `@${username}, ${variant}`;
  }
  return variant;
}

// ----------------------------------------
// === SCRAPING PUBLIC DIRECTORIES =======
// ----------------------------------------

/**
 * Scrape TelegramChannels.me for relevant channel usernames using exponential backoff.
 */
async function scrapeTelegramChannelsMe(): Promise<string[]> {
  const url = "https://telegramchannels.me/search?query=gas";
  try {
    const response = await retryWithBackoff(() =>
      axios.get(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36",
        },
        timeout: 20000,
      })
    );
    const html = response.data;
    const $ = cheerio.load(html);
    const channelUsernames: string[] = [];
    $(".channel-item .title a").each((_, el) => {
      const href = $(el).attr("href") || "";
      const parts = href.split("/").filter((p) => p);
      if (parts.length >= 2 && parts[0] === "channel") {
        channelUsernames.push("@" + parts[1]);
      }
    });
    return channelUsernames;
  } catch (err) {
    console.error("[SCRAPE] telegramchannels.me error:", (err as any).message || err);
    return [];
  }
}

/**
 * Scrape tlgrm.eu for relevant channel usernames using exponential backoff.
 */
async function scrapeTlgrmEu(): Promise<string[]> {
  const url = "https://tlgrm.eu/tag/gas";
  try {
    const response = await retryWithBackoff(() =>
      axios.get(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36",
        },
        timeout: 20000,
      })
    );
    const html = response.data;
    const $ = cheerio.load(html);
    const channelUsernames: string[] = [];
    $(".channel-list .channel a").each((_, el) => {
      const href = $(el).attr("href") || "";
      const match = href.match(/@[\w\d_]+/);
      if (match) {
        channelUsernames.push(match[0]);
      }
    });
    return channelUsernames;
  } catch (err) {
    console.error("[SCRAPE] tlgrm.eu error:", (err as any).message || err);
    return [];
  }
}

/**
 * Scrape telegramic.org for relevant channel usernames using exponential backoff.
 */
async function scrapeTelegramicOrg(): Promise<string[]> {
  const url = "https://telegramic.org/tag/gas/";
  try {
    const response = await retryWithBackoff(() =>
      axios.get(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36",
        },
        timeout: 20000,
      })
    );
    const html = response.data;
    const $ = cheerio.load(html);
    const channelUsernames: string[] = [];
    $(".tg-list .tg-list-item a").each((_, el) => {
      const href = $(el).attr("href") || "";
      const match = href.match(/@[\w\d_]+/);
      if (match) {
        channelUsernames.push(match[0]);
      }
    });
    return channelUsernames;
  } catch (err) {
    console.error("[SCRAPE] telegramic.org error:", (err as any).message || err);
    return [];
  }
}

/**
 * Use @TGStat_Bot to filter out low-engagement channels.
 * Returns true if channel has ≥ 500 daily views.
 */
async function filterByTGStatBot(username: string): Promise<boolean> {
  try {
    const botPeer = "@TGStat_Bot";
    const sentMsg = await client.sendMessage(botPeer, { message: `/stats ${username}` });
    await sleep(3000, 5000);
    const entity = await client.getEntity(botPeer);
    const inputPeer =
      entity instanceof Api.User && entity.accessHash !== undefined
        ? new Api.InputPeerUser({ userId: entity.id, accessHash: entity.accessHash })
        : null;
    if (!inputPeer) {
      return false;
    }
    const updates = (await client.invoke(
      new Api.messages.GetHistory({
        peer: inputPeer,
        limit: 5,
        offsetDate: 0,
        offsetId: sentMsg.id,
        maxId: 0,
        minId: 0,
        addOffset: 0,
        hash: Api.BigInteger.fromValue(0),
      })
    )) as any;
    const messages: Api.Message[] = updates.messages || [];
    for (const m of messages) {
      const text = (m as any).message as string;
      if (!text) continue;
      const match = text.match(/Views per day:\s*([\d,]+)/i);
      if (match) {
        const views = Number(match[1].replace(/,/g, ""));
        return views >= 500;
      }
      if (/not found/i.test(text) || /no data/i.test(text)) {
        return false;
      }
    }
    return false;
  } catch (err) {
    console.error(`[TGSTAT BOT] Error filtering ${username}:`, (err as any).message || err);
    return false;
  }
}

/**
 * Use Telegram’s contacts.Search to discover trending or related channels.
 * Returns an array of @usernames found.
 */
async function discoverViaTelegramAPI(keyword: string): Promise<string[]> {
  try {
    const result = (await client.invoke(
      new Api.contacts.Search({ q: keyword, limit: 50 })
    )) as any;
    const found: string[] = [];
    if (Array.isArray(result.chats)) {
      for (const ch of result.chats) {
        if (ch instanceof Api.Channel && ch.username) {
          found.push("@" + ch.username);
        }
      }
    }
    return found;
  } catch (err) {
    console.error(`[Global Discover] Error searching via Telegram API with "${keyword}":`, (err as any).message || err);
    return [];
  }
}

/**
 * Scrape public directories + global Telegram API search to build a candidate list.
 * Returns up to maxCandidates @usernames to consider joining.
 */
async function scrapePublicSources(maxCandidates: number): Promise<string[]> {
  const usernamesSet = new Set<string>();

  // 1) Scrape HTML directories concurrently
  const [chanMe, tlgrm, telemic] = await Promise.all([
    scrapeTelegramChannelsMe(),
    scrapeTlgrmEu(),
    scrapeTelegramicOrg(),
  ]);
  [...chanMe, ...tlgrm, ...telemic].forEach((u) => {
    if (u.startsWith("@")) usernamesSet.add(u);
  });

  // 2) Global Telegram API discovery
  for (const kw of config.discovery.globalSearchKeywords) {
    if (usernamesSet.size >= maxCandidates) break;
    const found = await discoverViaTelegramAPI(kw);
    found.forEach((u) => {
      if (u.startsWith("@")) usernamesSet.add(u);
    });
    // small delay to avoid rate limits
    await sleep(500, 1000);
  }

  // 3) Filter candidates via TGStatBot with batched concurrency
  const finalCandidates: string[] = [];
  for (const uname of usernamesSet) {
    if (finalCandidates.length >= maxCandidates) break;
    const ok = await filterByTGStatBot(uname);
    if (ok) finalCandidates.push(uname);
    await sleep(1500, 3000);
  }

  return finalCandidates;
}

// ----------------------------------------
// === DISCOVERY & QUEUE FUNCTIONS  =======
// ----------------------------------------

/**
 * 1) Scrape public directories and Telegram API to build up to maxScrapePerRun candidates.
 * 2) Batch enqueue new candidates into Redis list `candidatesToJoin` using pipeline.
 * 3) Log intel to Saved Messages.
 */
async function scrapeAndEnqueueCandidates() {
  console.log("[DISCOVERY] Running 30-minute scrape + enqueue");
  try {
    const scraped = await scrapePublicSources(config.discovery.maxScrapePerRun);
    const added: string[] = [];

    if (scraped.length > 0 && redis) {
      const pipeline = redis.pipeline();
      const existingQueue = await redis.lrange(config.discovery.candidateQueueKey, 0, -1);

      for (const uname of scraped) {
        if (added.length >= config.discovery.maxScrapePerRun) break;
        // Check blacklist
        const lower = uname.toLowerCase();
        let skip = false;
        for (const bad of config.discovery.blacklist) {
          if (lower.includes(bad)) {
            skip = true;
            break;
          }
        }
        if (skip) continue;

        // Only enqueue if not already present
        if (!existingQueue.includes(uname)) {
          pipeline.rpush(config.discovery.candidateQueueKey, uname);
          added.push(uname);
        }
      }
      await pipeline.exec();
    }

    if (added.length > 0) {
      const intelMsg = `[Intel][Scrape] Enqueued ${added.length} new candidates: ${added.join(", ")}`;
      console.log(intelMsg);
      await client.sendMessage("me", { message: intelMsg });
    } else {
      console.log("[Intel][Scrape] No new candidates to enqueue");
    }
  } catch (err) {
    console.error("[Scrape] Error during scrapeAndEnqueueCandidates:", (err as any).message || err);
    await client.sendMessage("me", {
      message: `[Intel][Scrape] Error during scrape: ${(err as any).message || err}`,
    });
  }
}

/**
 * Pop up to `maxJoinPerRun` candidates from Redis `candidatesToJoin`, then asynchronously process each:
 *   1) getInputChannel
 *   2) skip if recently joined or manually left
 *   3) join group
 *   4) fetch recent messages & check relevance/activity
 *   5) generate AI reply & send
 *   6) record stats in Redis & send intel to Saved Messages
 *   7) if join fails or no activity/relevance → leave & recordLeftGroup
 */
async function processCandidateQueue() {
  console.log("[PROCESS] Running 30-minute join+reply job");
  const todayDate = new Date().toISOString().slice(0, 10);
  const joinedCountKey = `stats:joins:${todayDate}`;
  const replyCountKey = `stats:aiReplies:${todayDate}`;
  const ctaCountKey = `stats:ctas:${todayDate}`;

  let joinedThisRun = 0;
  const toProcess: string[] = [];

  // Batch pop up to maxJoinPerRun
  if (redis) {
    for (let i = 0; i < config.discovery.maxJoinPerRun; i++) {
      const uname = await redis.lpop(config.discovery.candidateQueueKey);
      if (!uname) break;
      toProcess.push(uname);
    }
  }

  // Process each candidate asynchronously but sequentially to respect rate limits
  for (const uname of toProcess) {
    const inputChan = await getInputChannel(uname, 0);
    if (!inputChan) {
      console.warn(`[PROCESS] Could not resolve InputChannel for "${uname}", skipping`);
      await client.sendMessage("me", {
        message: `[Intel][Process] Candidate "${uname}" resolution failed. Skipped.`,
      });
      continue;
    }
    const channelIdNum = (inputChan as any).channelId as number;

    // Skip if recently joined
    if (await recentlyJoinedGroup(channelIdNum)) {
      console.log(`[PROCESS] Skipping ${uname} — joined recently`);
      await client.sendMessage("me", {
        message: `[Intel][Process] "${uname}" skipped (joined recently).`,
      });
      continue;
    }

    // Skip if manually left
    if (await hasLeftGroup(channelIdNum)) {
      console.log(`[PROCESS] Skipping ${uname} — manually left earlier`);
      continue;
    }

    // Attempt to join
    try {
      await client.invoke(new Api.channels.JoinChannel({ channel: uname }));
      recordJoinGroup(channelIdNum);
      if (redis) {
        await redis.incr(joinedCountKey);
        await redis.expire(joinedCountKey, 25 * 60 * 60);
      }
      joinedThisRun++;
      console.log(`[PROCESS] Successfully joined ${uname}`);

      // Fetch recent messages (last 20)
      const recentTexts = await fetchRecentMessages(inputChan, 20);
      // If fewer than 5 messages → leave immediately
      if (recentTexts.length < 5) {
        console.log(`[PROCESS] "${uname}" too low activity (<5 msgs) → leaving`);
        await client.invoke(new Api.channels.LeaveChannel({ channel: inputChan }));
        await recordLeftGroup(channelIdNum);
        await client.sendMessage("me", {
          message: `[Intel][Process] Joined "${uname}" but activity <5 msgs → left.`,
        });
        continue;
      }

      // Check relevance
      const isRelevant = containsRelevantKeyword(recentTexts);
      if (!isRelevant) {
        console.log(`[PROCESS] "${uname}" no relevant discussion → leaving`);
        await client.invoke(new Api.channels.LeaveChannel({ channel: inputChan }));
        await recordLeftGroup(channelIdNum);
        await client.sendMessage("me", {
          message: `[Intel][Process] Joined "${uname}" but no relevant discussion → left.`,
        });
        continue;
      }

      // Pick most relevant message
      const pickedText = pickMostRelevantMessage(recentTexts)!;
      const isRus = /[а-яё]/i.test(pickedText);
      const userMsgLength = pickedText.trim().split(/\s+/).length;
      const aiReply = await generateAIReply(pickedText, isRus, userMsgLength);
      if (!aiReply) {
        console.log(`[PROCESS] AI generation failed → leaving ${uname}`);
        await client.invoke(new Api.channels.LeaveChannel({ channel: inputChan }));
        await recordLeftGroup(channelIdNum);
        await client.sendMessage("me", {
          message: `[Intel][Process] AI reply generation failed for "${uname}". Left.`,
        });
        continue;
      }

      // Send AI reply
      const inputPeer = new Api.InputPeerChannel({
        channelId: (inputChan as any).channelId,
        accessHash: (inputChan as any).accessHash,
      });
      const sent = await safeSendMessage(inputPeer, aiReply);
      if (!sent) {
        console.log(`[PROCESS] AI reply send failed → leaving ${uname}`);
        await client.invoke(new Api.channels.LeaveChannel({ channel: inputChan }));
        await recordLeftGroup(channelIdNum);
        await client.sendMessage("me", {
          message: `[Intel][Process] AI reply send failed for "${uname}". Left.`,
        });
        continue;
      }

      console.log(`[PROCESS] Posted AI reply in "${uname}"`);
      if (redis) {
        await redis.incr(replyCountKey);
        await redis.expire(replyCountKey, 25 * 60 * 60);
      }
      await client.sendMessage("me", {
        message: `[Intel][Process] Joined and posted AI reply in "${uname}".`,
      });
    } catch (joinErr: any) {
      const msg = joinErr.errorMessage || joinErr.message || "";
      if (msg.includes("USER_ALREADY_PARTICIPANT")) {
        console.log(`[PROCESS] "${uname}" already a participant, skipping`);
        continue;
      }
      if (msg.includes("FLOOD_WAIT")) {
        const waitSeconds = parseInt(msg.match(/\d+/)?.[0] || "30", 10);
        console.warn(`[PROCESS] Flood wait when joining ${uname}: ${msg}`);
        console.log(`[PROCESS] Sleeping ${waitSeconds + 5}s to avoid rapid retries`);
        await new Promise((res) => setTimeout(res, (waitSeconds + 5) * 1000));
        break; // break out to prevent further rapid joins
      }
      console.error(`[PROCESS] Error joining ${uname}:`, msg);
      await client.sendMessage("me", {
        message: `[Intel][Process] Error joining "${uname}": ${msg}`,
      });
      await recordLeftGroup(channelIdNum);
    }

    // Human-like delay between attempts
    await sleep(1500, 2500);
  }

  console.log(`[PROCESS] Completed join job — joined this run: ${joinedThisRun}`);
}

// ----------------------------------------
// === HOURLY SUMMARY (Intelligent)  =====
// ----------------------------------------

/**
 * Every hour, send an “intelligent” summary to Saved Messages.
 * Uses OpenAI to:
 *   A) Summarize what happened this last hour (based on metrics).
 *   B) Function review and improvements (scrapeAndEnqueueCandidates, processCandidateQueue, generateAIReply, handleMessage, Redis logic).
 *   C) If “Channels joined” is zero, propose three tasks to improve.
 *   D) If “Conversions” is zero, propose three CTA/DM funnel adjustments.
 *   E) Suggest scheduling adjustments.
 */
function scheduleHourlySummary() {
  schedule.scheduleJob("0 * * * *", async () => {
    try {
      const now = new Date();
      const dateKey = now.toISOString().slice(0, 10);

      // Fetch hourly_stats from Redis
      const joinedThisHour = joinCountHour;
      const repliesThisHour = aiReplyCountHour;
      const ctasThisHour = ctaSentCountHour;
      const conversionsThisHour = conversionCountHour;

      // Reset counters for next hour
      joinCountHour = 0;
      aiReplyCountHour = 0;
      ctaSentCountHour = 0;
      conversionCountHour = 0;

      // Build prompt for OpenAI
      const promptLines = [
        `You are GasGuardian’s code analyst and hourly performance reviewer. It is now ${now.toLocaleString()}.`,
        `Metrics for the last hour:`,
        `- Channels joined: ${joinedThisHour}`,
        `- AI-driven replies sent: ${repliesThisHour}`,
        `- Generic CTAs sent: ${ctasThisHour}`,
        `- Successful conversions (users completing /test → Gmail): ${conversionsThisHour}`,
        ``,
        `Function Review and Improvements:`,
        `1. scrapeAndEnqueueCandidates()`,
        `2. processCandidateQueue()`,
        `3. generateAIReply()`,
        `4. handleMessage() (DM funnel, CTA logic)`,
        `5. Redis-based queue logic`,
        ``,
        `Tasks (provide actionable, code-specific suggestions with small code snippets where possible):`,
        `A) Summarize what happened this last hour (based on the metrics).`,
        `B) Function review above: identify inefficiencies or edge cases, provide examples.`,
        `C) If "Channels joined" is zero, propose three tasks to increase join rate or refine discovery next hour.`,
        `D) If "Conversions" is zero, propose three CTA or DM funnel adjustments (include updated text).`,
        `E) Suggest any scheduling adjustments (e.g., scrape frequency, join batch size).`,
        ``,
        `Use model gpt-4o. Write the response in two or three paragraphs, but include small code/pseudocode blocks for each suggestion.`,
      ];
      const prompt = promptLines.join("\n");

      const aiResponse = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: "You are an expert code reviewer and performance analyst for a Telegram recruitment bot." },
          { role: "user", content: prompt },
        ],
        max_tokens: 800,
        temperature: 0.7,
      });

      const summaryText = aiResponse.choices?.[0]?.message?.content?.trim() || "";
      await client.sendMessage("me", {
        message: `🕒 Hourly Intelligence Summary (${now.toLocaleString()}):\n\n${summaryText}`,
      });
    } catch (err) {
      console.error("[SUMMARY] Failed to generate hourly summary:", (err as any).message || err);
    }
  });
}

// ----------------------------------------
// === DAILY PERFORMANCE REVIEW  ========
// ----------------------------------------

/**
 * Every day at midnight, evaluate performance. If replies are low or join-to-reply ratio is poor,
 * generate a 2-paragraph performance summary via OpenAI and send to Saved Messages.
 */
function scheduleDailyPerformanceReview() {
  schedule.scheduleJob("0 0 * * *", async () => {
    try {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const joinedKey = `stats:joins:${yesterday}`;
      const repliedKey = `stats:aiReplies:${yesterday}`;
      const ctaKey = `stats:ctas:${yesterday}`;
      const convKey = `stats:conversions:${yesterday}`;

      let joinedCount = 0;
      let repliedCount = 0;
      let ctaCount = 0;
      let conversionCount = 0;

      if (redis) {
        joinedCount = Number((await redis.get(joinedKey)) || 0);
        repliedCount = Number((await redis.get(repliedKey)) || 0);
        ctaCount = Number((await redis.get(ctaKey)) || 0);
        conversionCount = Number((await redis.get(convKey)) || 0);
      }

      const joinReplyRatio = joinedCount > 0 ? repliedCount / joinedCount : 0;
      if (joinedCount < 20 || joinReplyRatio < 0.1) {
        const prompt = `You are reviewing the GasGuardian recruitment bot's daily performance for ${yesterday}.\n
Metrics:\n
- Total channels joined: ${joinedCount}\n
- AI-driven replies sent: ${repliedCount}\n
- Generic CTAs sent: ${ctaCount}\n
- Conversions (DM funnel): ${conversionCount}\n
\n
Please write a 2-paragraph analysis:\n
1. Summarize how the bot performed yesterday, including possible reasons for low engagement.\n
2. Suggest concrete improvements to increase join rates, reply rates, or DM funnel conversions in the next 24 hours.\n`;

        const reviewRes = await openai.chat.completions.create({
          model: "gpt-4o",
          messages: [
            { role: "system", content: "You are an expert analyst for Telegram community engagement bots." },
            { role: "user", content: prompt },
          ],
          max_tokens: 300,
          temperature: 0.7,
        });
        const reviewText = reviewRes.choices?.[0]?.message?.content?.trim() || "";
        await client.sendMessage("me", {
          message: `📈 Daily Performance Review for ${yesterday}:\n\n${reviewText}`,
        });
      }

      // Reset or archive keys
      if (redis) {
        await redis.del(joinedKey);
        await redis.del(repliedKey);
        await redis.del(ctaKey);
        await redis.del(convKey);
      }
    } catch (err) {
      console.error("[DAILY REVIEW] Error generating performance review:", (err as any).message || err);
    }
  });
}

// ----------------------------------------
// === DM FUNNEL & STATS TRACKING  =======
// ----------------------------------------

/**
 * When a user completes the `/test` → Gmail funnel, store a conversion metric.
 */
async function recordConversion(userId: string) {
  conversionCountHour++;
  const today = new Date().toISOString().slice(0, 10);
  const convKey = `stats:conversions:${today}`;
  if (redis) {
    await redis.incr(convKey);
    await redis.expire(convKey, 7 * 24 * 60 * 60); // keep conversions for 7 days
  }
}

// ----------------------------------------
// === MAIN MESSAGE HANDLER  ==============
// ----------------------------------------

async function handleMessage(e: NewMessageEvent) {
  const msg = e.message;
  if (!msg || msg.out || !msg.text) return;

  const peerClass = msg.peerId?.className;
  let groupId = 0;
  let userId = "";

  if (peerClass === "PeerChannel" || peerClass === "PeerChat") {
    groupId = (msg.peerId as any).channelId || (msg.peerId as any).chatId || 0;
  } else if (peerClass === "PeerUser") {
    userId = msg.senderId?.toString() || "";
  }

  // 1) Do not reply if any sensitive/“official” word is present
  if (SENSITIVE_REGEX.test(msg.text)) {
    return;
  }

  // 2) Group/channel logic (for live conversations)
  if (peerClass === "PeerChannel" || peerClass === "PeerChat") {
    if (!(await canReplyGroup(groupId))) {
      return;
    }
    if (await recentlyJoinedGroup(groupId)) {
      return;
    }
    if (await hasLeftGroup(groupId)) {
      return;
    }

    let aiIntent = "";
    let ctaAllowed = false;
    const userText = msg.text;
    const isRussian = /[а-яё]/i.test(userText);
    const fromUsername = (msg.senderId && msg.chat) ? (msg.chat.username || "") : "";

    // 2a) Use OpenAI to classify intent & prepare a context-aware reply if needed.
    try {
      const systemPrompt = isRussian
        ? "Ты бот в крипто-чате. Сначала читай и отвечай по теме. Если человек спрашивает о снижении комиссий, дай полезный совет. Не упоминай GasGuardian сразу, только если это уместно."
        : "You are a bot in a crypto group. Read carefully and respond on topic. If the user asks about lowering fees, give a helpful tip. Do not mention GasGuardian up front—only if it truly fits.";
      const optimized = optimizePrompt(userText);

      const gptRes = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: optimized },
        ],
        max_tokens: 180,
        temperature: 0.6,
      });
      aiIntent = gptRes.choices?.[0]?.message?.content?.trim() || "";
      // Check if the user's text contains any CTA-trigger words
      ctaAllowed = /\b(help|interested|how|where|gas|fees|defi|arbitrum|optimism|polygon|solana|base|binance)\b/i.test(
        userText
      );
    } catch {
      return;
    }

    // 2b) If OpenAI gave a reply (“aiIntent”), we post that reply exactly as is.
    if (aiIntent) {
      const inputEntity = await client.getInputEntity(msg.peerId);
      const sent = await safeSendMessage(inputEntity, aiIntent, msg.id);
      if (sent) {
        await recordGroupReply(groupId);
        if (redis) {
          const today = new Date().toISOString().slice(0, 10);
          await redis.incr(`stats:aiReplies:${today}`);
          await redis.expire(`stats:aiReplies:${today}`, 25 * 60 * 60);
        }
        await client.sendMessage("me", {
          message: `[SplitTest][Group ${groupId}] Posted AI‐driven reply: "${aiIntent}"`,
        });
      }
      return;
    }

    // 2c) If GPT returned nothing but ctaAllowed = true, send a human‐style CTA.
    if (!aiIntent && ctaAllowed) {
      const replyText = pickRandomCTA(fromUsername);
      const inputEntity = await client.getInputEntity(msg.peerId);
      const sent = await safeSendMessage(inputEntity, replyText, msg.id);
      if (sent) {
        await recordGroupReply(groupId);
        ctaSentCountHour++;
        if (redis) {
          const today = new Date().toISOString().slice(0, 10);
          await redis.incr(`stats:ctas:${today}`);
          await redis.expire(`stats:ctas:${today}`, 25 * 60 * 60);
        }
        await client.sendMessage("me", {
          message: `[SplitTest][Group ${groupId}] Sent generic CTA: "${replyText}"`,
        });
      }
      return;
    }

    // 2d) Otherwise (AI returned nothing, and ctaAllowed = false), remain silent.
    return;
  }

  // 3) DM funnel: handle "/test" and Gmail replies
  if (peerClass === "PeerUser") {
    const gmailPattern = /^[a-zA-Z0-9._%+-]+@gmail\.com$/i;
    // 3a) If user replies with Gmail & has a pending reminder
    if (gmailPattern.test(msg.text.trim().toLowerCase())) {
      const pending = redis ? await redis.get(`pendingReminder:${userId}`) : null;
      if (pending) {
        await client.sendMessage(msg.peerId, {
          message: config.recruitment.confirmation,
          replyTo: msg.id,
        });
        if (redis) {
          await redis.set(`converted:${userId}`, "1", "EX", 7 * 24 * 3600);
          await redis.del(`pendingReminder:${userId}`);
          await redis.del(`pendingUGC:${userId}`);
          // Save intel: user converted
          await client.sendMessage("me", {
            message: `[Intel][DM] User ${userId} provided Gmail and converted to beta funnel.`,
          });
          await recordConversion(userId);
        }
        return;
      }
    }

    // 3b) If user sends "/test"
    if (/^\/test/i.test(msg.text.trim())) {
      await client.sendMessage(msg.peerId, {
        message: config.recruitment.betaInstructions,
        replyTo: msg.id,
      });
      if (redis) {
        await redis.set(`pendingReminder:${userId}`, "1", "EX", DM_REMINDER_MIN * 60);
        // Save intel: user asked to join beta
        await client.sendMessage("me", {
          message: `[Intel][DM] User ${userId} triggered /test funnel.`,
        });

        // Send reminder after 30 minutes if still pending
        setTimeout(async () => {
          const isConverted = await redis.get(`converted:${userId}`);
          const stillPending = await redis.get(`pendingReminder:${userId}`);
          if (!isConverted && stillPending) {
            await client.sendMessage(msg.peerId, {
              message:
                "Still interested in the GasGuardian beta? Just reply with your Gmail to get instant access! 🚀",
            });
            await redis.set(`pendingUGC:${userId}`, "1", "EX", 2 * DM_REMINDER_MIN * 60);
            await redis.del(`pendingReminder:${userId}`);
            // Save intel: sent DM reminder
            await client.sendMessage("me", {
              message: `[Intel][DM] Sent 30-min DM reminder to user ${userId}.`,
            });
          }
        }, DM_REMINDER_MIN * 60 * 1000);

        // Send UGC prompt after 90 minutes if still pending
        setTimeout(async () => {
          const isConverted = await redis.get(`converted:${userId}`);
          const ugcPending = await redis.get(`pendingUGC:${userId}`);
          if (!isConverted && ugcPending) {
            await client.sendMessage(msg.peerId, {
              message: config.recruitment.ugcPrompt,
            });
            await redis.del(`pendingUGC:${userId}`);
            // Save intel: sent UGC prompt
            await client.sendMessage("me", {
              message: `[Intel][DM] Sent UGC prompt to user ${userId}.`,
            });
          }
        }, 3 * DM_REMINDER_MIN * 60 * 1000);
      }
      return;
    }
  }
}

// ----------------------------------------
// === SCHEDULER SETUP  ================
// ----------------------------------------

async function main() {
  await client.start({
    phoneNumber: async () => "",
    password: async () => "",
    phoneCode: async () => "",
    onError: (err) => console.error("[TG] Client error:", err),
  });

  console.log("[BOT] Client started, registering event handler");
  client.addEventHandler(handleMessage, new NewMessage({}));

  // 1) Schedule 30-minute scraping + enqueue job
  console.log("[SCHEDULER] Scheduling 30-minute scrape+enqueue job");
  schedule.scheduleJob("*/30 * * * *", async () => {
    await scrapeAndEnqueueCandidates();
  });

  // 2) Schedule 30-minute join+reply job
  console.log("[SCHEDULER] Scheduling 30-minute join+reply job");
  schedule.scheduleJob("*/30 * * * *", async () => {
    await processCandidateQueue();
  });

  // 3) Schedule intelligent hourly summary
  scheduleHourlySummary();

  // 4) Schedule daily performance review
  scheduleDailyPerformanceReview();

  console.log("[GasGuardian] Bot started and listening for messages.");
}

main().catch((err) => {
  console.error("[FATAL ERROR]", err);
  process.exit(1);
});

// ----------------------------------------
// === BOOT LOGGING ======================
// ----------------------------------------

console.log("=== [BOOT] GasGuardian bot environment ready! ===");
console.log("[BOOT] Recruitment CTA configured.");
console.log("[BOOT] Redis connection status:", !!redis);
console.log("[BOOT] Prisma client initialized:", !!prisma);
console.log("[BOOT] OpenAI client initialized:", !!openai.apiKey);
console.log("[BOOT] Bot is ready to start processing messages.");
console.log("[BOOT] Bot will now run a 30-minute scrape → enqueue cycle.");
console.log("[BOOT] Bot will run a 30-minute join → reply cycle.");
console.log("[BOOT] Intelligent hourly summaries and daily reviews are scheduled.");
console.log("[BOOT] Bot is now live and ready to disrupt recruitment in crypto communities!");

// gasguardian-userbot.ts
// GasGuardian Disruptive Recruitment Userbot
// ➤ 5-minute “discover” (scrape + enqueue) + 30-minute “join/reply” cycle
// ➤ Scraping now skips 403/404 immediately (no backoff retries cluttering logs).
// ➤ TGStatBot filter now sends a t.me link instead of `/stats @username`.
// ➤ Rest of the logic (Redis queue, AI replies, DM funnel, summaries) is unchanged.
// Updated: 06/05/2025 (using gpt-4o)

import * as path from "path";
import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: path.resolve(process.cwd(), ".env") });

import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions";
import { NewMessage, NewMessageEvent } from "telegram/events";
import OpenAI from "openai";
import axios, { AxiosResponse } from "axios";
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
  TGSTAT_SEARCH_KEY: getEnv("TGSTAT_SEARCH_KEY"), // optionally used elsewhere
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
const DM_REMINDER_MIN = 30;    // minutes before DM follow-up

/**
 * A broadened list of “trigger keywords” in English and Russian
 * to capture more valid groups.
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

const config = {
  telegram: {
    apiId: env.TG_API_ID,
    apiHash: env.TG_API_HASH,
    session: env.TG_SESSION,
  },
  recruitment: {
    // Simplified CTA: no direct GasGuardian pitch, just offer help.
    ctaGenericVariants: [
      "Hmu if you need more help with gas fees! 😊",
      "Let me know if I can help more with gas optimization!",
      "Feel free to DM if gas fees are still bothering you!",
    ],
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
    // We “discover” every 5 minutes and “join” every 30 minutes.
    minMembers: 200,
    maxScrapePerRun: 100, // max candidates to enqueue in each 5-minute scrape
    maxJoinPerRun: 30,    // how many to attempt in each 30-minute join slot
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
    // We’ll store scraped candidates in Redis list "candidatesToJoin"
    candidateQueueKey: "candidatesToJoin",
  },
};

// ----------------------------------------
// === UTILITY / THROTTLING  FUNCTIONS  ==
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

/** Sleep for a randomized interval between min–max milliseconds. */
function sleep(minMs: number, maxMs: number): Promise<void> {
  const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((res) => setTimeout(res, delay));
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
  // Fallback: if no Redis, allow only one reply per hour as before
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
    // fallback: record timestamp
    groupReplyTimestamps[`grp:${groupId}`] = Date.now();
  }
}

/** Check if we have recently joined this group (waiting period). */
async function recentlyJoinedGroup(groupId: number): Promise<boolean> {
  const key = `join:${groupId}`;
  if (redis) {
    const t = await redis.ttl(key);
    return t > 0; // still in wait period
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
 * Safely send a message, catching CHAT_ADMIN_REQUIRED and other
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
 * Given a username (e.g. "eth_gas_tracker") or a numeric channel ID string,
 * return an Api.InputChannel (with accessHash) so we can post or leave.
 */
async function getInputChannel(
  usernameOrId: string
): Promise<Api.InputChannel | null> {
  try {
    let entity: any;
    if (/^[0-9]+$/.test(usernameOrId)) {
      // It's numeric: resolve by ID
      const numeric = Number(usernameOrId);
      entity = await client.getEntity(numeric);
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
 * Ask OpenAI to generate a concise, context-driven reply to the given `promptText`.
 * It will read the last message(s) and respond *in a way that directly addresses the conversation*—
 * only mentioning GasGuardian if it’s a natural fit. Returns the generated reply (or empty string on failure).
 * Adjusted prompt to match vibe based on message length.
 */
async function generateAIReply(
  promptText: string,
  isRussian: boolean,
  userMsgLength: number
): Promise<string> {
  try {
    let systemPrompt: string;
    if (isRussian) {
      systemPrompt =
        "Ты бот, который внимательно читает чат и отвечает по теме. Если обсуждают высокие комиссии, дай совет, как их снизить. Не упоминай GasGuardian сразу, только если это действительно поможет. Старайся писать в стиле участника группы.";
    } else {
      systemPrompt =
        "You are a context-aware assistant that carefully reads the chat and replies topically. If people are discussing high gas fees, give a genuine tip on how to lower fees. Don’t mention GasGuardian up front—only if it truly fits. Match the tone/length of the original message.";
    }

    // If the user message was very short (<5 words), generate an equally short, friendly reply
    const userPrompt = isRussian
      ? `Последнее сообщение: "${promptText}"\nНапиши короткий, дружелюбный ответ, соответствующий длине: не более ${
          userMsgLength < 5 ? "5 слов" : "15 слов"
        }${userMsgLength < 5 ? ", очень неформально" : ""}.`
      : `Last message: "${promptText}"\nWrite a short, friendly reply matching the length: no more than ${
          userMsgLength < 5 ? "5 words" : "15 words"
        }${userMsgLength < 5 ? ", keep it super casual" : ""}.`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: userMsgLength < 5 ? 30 : 60,
      temperature: 0.7,
    });
    aiReplyCountHour++;
    return response.choices?.[0]?.message?.content?.trim() || "";
  } catch (e) {
    console.error("[AI REPLY] Error generating reply:", (e as any).message || e);
    return "";
  }
}

/**
 * Randomly pick one of the CTA variants.
 */
function pickRandomCTA(): string {
  const variants = config.recruitment.ctaGenericVariants;
  return variants[Math.floor(Math.random() * variants.length)];
}

// ----------------------------------------
// === SCRAPING PUBLIC DIRECTORIES =======
// ----------------------------------------

/**
 * Scrape TelegramChannels.me for relevant channel usernames.
 * Returns an array of @usernames found on site that match our keywords.
 * (Now: if we get a 403/404, we immediately return an empty array.)
 */
async function scrapeTelegramChannelsMe(): Promise<string[]> {
  const url = "https://telegramchannels.me/search?query=gas";
  try {
    const response: AxiosResponse<string> = await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36",
      },
      timeout: 20000,
      validateStatus: (status) => status === 200, // reject any non-200 immediately
    });

    const html = response.data;
    const $ = cheerio.load(html);
    const channelUsernames: string[] = [];

    // On telegramchannels.me, channels are listed in .channel-item .title a[href]
    $(".channel-item .title a").each((_, el) => {
      const href = $(el).attr("href") || "";
      // href is like "/channel/ethgasstation"
      const parts = href.split("/").filter((p) => p);
      if (parts.length >= 2 && parts[0] === "channel") {
        const uname = "@" + parts[1];
        channelUsernames.push(uname);
      }
    });

    return channelUsernames;
  } catch (err: any) {
    if (err.response && (err.response.status === 403 || err.response.status === 404)) {
      console.warn(`[SCRAPE] telegramchannels.me returned ${err.response.status}, skipping.`);
      return [];
    }
    console.error("[SCRAPE] Error scraping telegramchannels.me:", err.message || err);
    return [];
  }
}

/**
 * Scrape tlgrm.eu for relevant channel usernames.
 * Returns an array of @usernames found on site that match our keywords.
 * (If we get 403/404, immediately return empty array.)
 */
async function scrapeTlgrmEu(): Promise<string[]> {
  const url = "https://tlgrm.eu/tag/gas";
  try {
    const response: AxiosResponse<string> = await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36",
      },
      timeout: 20000,
      validateStatus: (status) => status === 200,
    });

    const html = response.data;
    const $ = cheerio.load(html);
    const channelUsernames: string[] = [];

    // On tlgrm.eu, channels often in .channel-list .channel a[href]
    $(".channel-list .channel a").each((_, el) => {
      const href = $(el).attr("href") || "";
      const match = href.match(/@[\w\d_]+/);
      if (match) {
        channelUsernames.push(match[0]);
      }
    });

    return channelUsernames;
  } catch (err: any) {
    if (err.response && (err.response.status === 403 || err.response.status === 404)) {
      console.warn(`[SCRAPE] tlgrm.eu returned ${err.response.status}, skipping.`);
      return [];
    }
    console.error("[SCRAPE] Error scraping tlgrm.eu:", err.message || err);
    return [];
  }
}

/**
 * Scrape telegramic.org for relevant channel usernames.
 * Returns an array of @usernames found on site that match our keywords.
 * (If 403/404, return empty array.)
 */
async function scrapeTelegramicOrg(): Promise<string[]> {
  const url = "https://telegramic.org/tag/gas/";
  try {
    const response: AxiosResponse<string> = await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36",
      },
      timeout: 20000,
      validateStatus: (status) => status === 200,
    });

    const html = response.data;
    const $ = cheerio.load(html);
    const channelUsernames: string[] = [];

    // On telegramic.org, channels are in .tg-list .tg-list-item a[href]
    $(".tg-list .tg-list-item a").each((_, el) => {
      const href = $(el).attr("href") || "";
      const match = href.match(/@[\w\d_]+/);
      if (match) {
        channelUsernames.push(match[0]);
      }
    });

    return channelUsernames;
  } catch (err: any) {
    if (err.response && (err.response.status === 403 || err.response.status === 404)) {
      console.warn(`[SCRAPE] telegramic.org returned ${err.response.status}, skipping.`);
      return [];
    }
    console.error("[SCRAPE] Error scraping telegramic.org:", err.message || err);
    return [];
  }
}

/**
 * Use @TGStat_Bot to filter out low-engagement channels.
 * Now: we send "https://t.me/<username-without-@>" instead of `/stats @username`.
 * Returns true if channel has ≥ 500 daily views.
 */
async function filterByTGStatBot(username: string): Promise<boolean> {
  try {
    const botPeer = "@TGStat_Bot";
    // Construct a t.me link from the username (strip leading '@')
    const raw = username.startsWith("@") ? username.slice(1) : username;
    const channelLink = `https://t.me/${raw}`;

    // Send the link to TGStatBot
    const sentMsg = await client.sendMessage(botPeer, { message: channelLink });
    await sleep(3000, 5000);

    const entity = await client.getEntity(botPeer);
    const updates = (await client.invoke(
      new Api.messages.GetHistory({
        peer:
          entity instanceof Api.User && entity.accessHash !== undefined
            ? new Api.InputPeerUser({ userId: entity.id, accessHash: entity.accessHash })
            : (() => {
                throw new Error("Entity is not a User or missing accessHash");
              })(),
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

      // Look for "Views per day: 12,345"
      const match = text.match(/Views per day:\s*([\d,]+)/i);
      if (match) {
        const views = Number(match[1].replace(/,/g, ""));
        return views >= 500;
      }
      // If it says "not found" or "no data", skip this channel
      if (/not found/i.test(text) || /no data/i.test(text)) {
        return false;
      }
    }
    return false;
  } catch (err: any) {
    console.error(`[TGSTAT BOT] Error filtering ${username}:`, err.message || err);
    return false;
  }
}

/**
 * Scrape public directories + TGStatBot to build a candidate list.
 * Returns a deduplicated array of @usernames to consider joining.
 */
async function scrapePublicSources(maxCandidates: number): Promise<string[]> {
  const usernamesSet = new Set<string>();

  // 1) Scrape HTML directories
  const [chanMe, tlgrm, telemic] = await Promise.all([
    scrapeTelegramChannelsMe(),
    scrapeTlgrmEu(),
    scrapeTelegramicOrg(),
  ]);

  [...chanMe, ...tlgrm, ...telemic].forEach((u) => {
    if (u.startsWith("@")) usernamesSet.add(u);
  });

  // 2) Filter each candidate via TGStatBot
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
 * 1) Scrape public directories to build up to maxScrapePerRun candidates.
 * 2) Push new candidates into Redis list `candidatesToJoin`.
 * 3) Log intel to Saved Messages.
 */
async function scrapeAndEnqueueCandidates() {
  console.log("[DISCOVERY] Running 5-minute scrape + enqueue");
  try {
    const scraped = await scrapePublicSources(config.discovery.maxScrapePerRun);
    const added: string[] = [];

    for (const uname of scraped) {
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

      // Only enqueue if not already in Redis queue
      const queueContents = await redis?.lrange(config.discovery.candidateQueueKey, 0, -1);
      if (queueContents && !queueContents.includes(uname)) {
        await redis!.rpush(config.discovery.candidateQueueKey, uname);
        added.push(uname);
      }
      if (added.length >= config.discovery.maxScrapePerRun) break;
    }

    if (added.length > 0) {
      const intelMsg = `[Intel][Scrape] Enqueued ${added.length} new candidates: ${added.join(
        ", "
      )}`;
      console.log(intelMsg);
      await client.sendMessage("me", { message: intelMsg });
    } else {
      console.log("[Intel][Scrape] No new candidates to enqueue");
    }
  } catch (err: any) {
    console.error("[Scrape] Error during scrapeAndEnqueueCandidates:", err.message || err);
    await client.sendMessage("me", {
      message: `[Intel][Scrape] Error during scrape: ${err.message || err}`,
    });
  }
}

/**
 * Pop up to `maxJoinPerRun` candidates from Redis `candidatesToJoin`, then attempt:
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
  for (let i = 0; i < config.discovery.maxJoinPerRun; i++) {
    // Pop one candidate
    const uname = await redis?.lpop(config.discovery.candidateQueueKey);
    if (!uname) break;

    const inputChan = await getInputChannel(uname);
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
      console.log(`[PROCESS] Successfully joined ${uname}`);
      joinedThisRun++;

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

      // Generate AI reply
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
        break;
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
 * Every hour, send an “intelligent” summary to Saved Messages. Instead of a static list,
 * we use OpenAI to:
 *   1) Summarize what happened (joins/replies/CTAs/conversions)
 *   2) Analyze each major function (scrape, process queue, AI-reply, etc.) and suggest
 *      code-level improvements with small examples.
 *   3) If zero groups joined or zero conversions, explicitly prompt for “if no groups joined,
 *      here are three example things you could do…”.
 *   4) Check TGStat conversion metrics: did anyone convert (i.e. send `/test`)? 
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
        `Review the following key functions of the bot code:`,
        `1. scrapeAndEnqueueCandidates()`,
        `2. processCandidateQueue()`,
        `3. generateAIReply()`,
        `4. handleMessage() (DM funnel, CTA logic)`,
        `5. The new Redis-based queue logic.`,
        ``,
        `Tasks (provide actionable, code-specific suggestions with small code snippets where possible):`,
        `A) Summarize what happened this last hour (based on the metrics).`,
        `B) For each of the above functions, identify any potential inefficiencies or edge cases. Provide a short code snippet or pseudocode illustrating how to improve (e.g., optimize selector, adjust backoff, refine prompt to OpenAI, reduce redundant Redis calls).`,
        `C) If “Channels joined” is zero, propose three specific tasks the bot could run (with code-level pseudocode examples) to increase join rate or refine discovery next hour.`,
        `D) If “Conversions” is zero, propose three specific adjustments to the DM funnel or CTA wording (include updated text snippets) to boost conversion until we get the first /test command.`,
        `E) Suggest any adjustments to scheduling (e.g., adjust scraping frequency, adjust join batch size).`,
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
    } catch (err: any) {
      console.error("[SUMMARY] Failed to generate hourly summary:", err.message || err);
    }
  });
}

// ----------------------------------------
// === DAILY PERFORMANCE REVIEW  ========
// ----------------------------------------

/**
 * Every day at midnight, evaluate performance. If replies are low or join-to-reply ratio is poor,
 * generate a 2-paragraph performance summary via OpenAI and send to Saved Messages.
 * Now also includes conversions in analysis.
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
- Conversions (DM funnel) : ${conversionCount}\n
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
    } catch (err: any) {
      console.error("[DAILY REVIEW] Error generating performance review:", err.message || err);
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

  // Move peerClass, groupId, userId declaration here so both group and DM logic can use them
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

    // 2a) Use OpenAI to classify intent & prepare a context-aware reply if needed.
    try {
      const systemPrompt = isRussian
        ? "Ты бот в крипто-чате. Сначала читай и отвечай по теме. Если человек спрашивает о снижении комиссий, дай полезный совет. Не упоминай GasGuardian сразу, только если это уместно."
        : "You are a bot in a crypto group. Read carefully and respond on topic. If the user asks about lowering fees, give a helpful tip. Do not mention GasGuardian up front—only if it truly fits.";

      const gptRes = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userText },
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
          message: `[SplitTest][Group ${groupId}] Posted AI-driven reply: "${aiIntent}"`,
        });
      }
      return;
    }

    // 2c) If GPT returned nothing but ctaAllowed = true, send a human-style CTA.
    if (!aiIntent && ctaAllowed) {
      const replyText = pickRandomCTA();
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
    // 3a) If user replies with Gmail & has a pending reminder
    const gmailPattern = /^[a-zA-Z0-9._%+-]+@gmail\.com$/i;
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

  // 1) Schedule 5-minute scraping + enqueue job
  console.log("[SCHEDULER] Scheduling 5-minute scrape+enqueue job");
  schedule.scheduleJob("*/5 * * * *", async () => {
    await scrapeAndEnqueueCandidates();
  });

  // 2) Schedule 30-minute join+reply job
  console.log("[SCHEDULER] Scheduling 30-minute join+reply job");
  schedule.scheduleJob("0,30 * * * *", async () => {
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
console.log("[BOOT] Bot will now run a 5-minute scrape → enqueue cycle.");
console.log("[BOOT] Bot will run a 30-minute join → reply cycle.");
console.log("[BOOT] Intelligent hourly summaries and daily reviews are scheduled.");
console.log("[BOOT] Bot is now live and ready to disrupt recruitment in crypto communities!");

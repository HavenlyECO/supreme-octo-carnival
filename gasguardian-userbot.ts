/**
 * GasGuardian - Advanced Multi-Chain Crypto Assistant & Beta Recruitment Userbot
 * 
 * Features:
 * - Real-time crypto data from 6+ specialized APIs
 * - GPT-4o powered message analysis and reply generation
 * - Smart beta-tester recruitment with referral tracking
 * - Auto-discovery of relevant crypto groups/channels
 * - A/B testing and analytics system for optimization
 * - Owner dashboard and comprehensive data reporting
 * 
 * Version: 2.0.0
 * Last updated: 2025-05-30
 */

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

// ==========================================================
// SETUP & CONFIGURATION
// ==========================================================

// Clients
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");
const prisma = new PrismaClient();

// Bot configuration
const config = {
  telegram: {
    apiId: Number(process.env.TG_API_ID),
    apiHash: process.env.TG_API_HASH as string,
    session: process.env.TG_SESSION as string,
    ownerChat: Number(process.env.OWNER_CHAT_ID),
  },
  reply: {
    maxLength: 180,
    minGroupGapSec: 900, // 15 min per group
    minUserGapSec: 3600, // 1 hour per user in groups
    dmRateLimitSec: 60,  // 1 min between DM replies
    rateBackoffMultiplier: 1.5,
    skipMsg: "SKIP",
    testingLimit: 100,   // Max beta testers
    languageProbability: 0.85, // Min confidence for English detection
    sentimentThreshold: 0.6,   // Min negative sentiment score
    ctaCooldownHours: 24,      // Hours between CTAs for same user
  },
  recruitment: {
    // A/B testing variants - system will rotate and track performance
    ctaVariants: [
      "DM me '/test' for VIP beta access (limited spots)!",
      "Want early access? DM '/test' to join our beta!",
      "Gas bothering you? DM '/test' for our solution's beta.",
      "Join 100 exclusive testers: DM '/test' now."
    ],
    betaInstructions: "You're in! We'll whitelist your email for the GasGuardian Android beta. Please reply with your Gmail address.",
    confirmationMessage: "Thanks! You're now on our VIP beta list. You'll receive an invite within 24h. Early access, priority support, and gas refunds await!",
  },
  api: {
    bitlyToken: process.env.BITLY_TOKEN,
    blocknativeKey: process.env.BLOCKNATIVE_KEY,
    bitqueryKey: process.env.BITQUERY_KEY,
    cryptoPanicKey: process.env.CRYPTO_PANIC_KEY,
    coinglassKey: process.env.COINGLASS_KEY,
    dappRadarKey: process.env.DAPPRADAR_KEY,
  },
  db: {
    testerTable: "beta_testers",
    interactionTable: "interactions",
    analyticsTable: "analytics",
    referralTable: "referrals",
    groupTable: "monitored_groups",
    discoveredGroupTable: "discovered_groups",
    discoveryLogTable: "discovery_logs",
    abTestTable: "ab_test_results",
  },
  discovery: {
    keywords: [
      "gas", "eth", "ethereum", "defi", "nft", "crypto", "blockchain", 
      "airdrop", "layer2", "degen", "token", "polygon", "arbitrum", 
      "optimism", "base", "solana", "trading", "yield", "staking"
    ],
    intervalHours: 12,
    maxGroupsPerSearch: 15,
    minGroupSize: 100,
    blacklistedWords: ["scam", "porn", "betting", "gambling"],
  },
  schedules: {
    discoveryTime: "0 */12 * * *",  // Every 12 hours
    analyticsTime: "0 0 * * *",     // Daily at midnight
    leaderboardTime: "0 12 * * 1",  // Weekly on Monday at noon
  }
};

// Chain configurations
const chains = [
  { id: 1, name: "Ethereum", symbol: "ETH", emoji: "⛽" },
  { id: 137, name: "Polygon", symbol: "MATIC", emoji: "🟣" },
  { id: 56, name: "BNB Chain", symbol: "BNB", emoji: "🟨" },
  { id: 42161, name: "Arbitrum", symbol: "ETH", emoji: "🔵" },
  { id: 10, name: "Optimism", symbol: "ETH", emoji: "🔴" },
  { id: 8453, name: "Base", symbol: "ETH", emoji: "🔷" }
];

// Message types for analysis
enum MessageIntentType {
  GAS_COMPLAINT = "gas_complaint",
  TOKEN_INQUIRY = "token_inquiry",
  DEFI_QUESTION = "defi_question",
  NFT_DISCUSSION = "nft_discussion",
  GENERAL_CRYPTO = "general_crypto",
  OFF_TOPIC = "off_topic",
}

// Data source types
enum DataSourceType {
  BLOCKNATIVE = "blocknative",
  BITQUERY = "bitquery",
  COINGECKO = "coingecko",
  CRYPTOPANIC = "cryptopanic",
  COINGLASS = "coinglass",
  DAPPRADAR = "dappradar",
  GPT = "gpt",
}

// Types
interface AnalyzedMessage {
  isEnglish: boolean;
  sentiment: number; // -1 to 1, negative to positive
  intent: MessageIntentType;
  entities: {
    chains: string[];
    tokens: string[];
    protocols: string[];
  };
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

// ==========================================================
// UTILS & HELPERS
// ==========================================================

const sleep = (ms: number): Promise<void> => new Promise(res => setTimeout(res, ms));

// Rate limiting helpers
async function canReplyInGroup(chatId: number): Promise<boolean> {
  const key = `ratelimit:group:${chatId}`;
  const last = await redis.get(key);
  if (!last) return true;
  
  const elapsed = Date.now() - parseInt(last);
  return elapsed > config.reply.minGroupGapSec * 1000;
}

async function canReplyToUser(userId: number): Promise<boolean> {
  const key = `ratelimit:user:${userId}`;
  const last = await redis.get(key);
  if (!last) return true;
  
  const elapsed = Date.now() - parseInt(last);
  return elapsed > config.reply.minUserGapSec * 1000;
}

async function canReplyInDM(userId: number): Promise<boolean> {
  const key = `ratelimit:dm:${userId}`;
  const last = await redis.get(key);
  if (!last) return true;
  
  const elapsed = Date.now() - parseInt(last);
  return elapsed > config.reply.dmRateLimitSec * 1000;
}

async function markReplyInGroup(chatId: number): Promise<void> {
  await redis.set(`ratelimit:group:${chatId}`, Date.now().toString());
}

async function markReplyToUser(userId: number): Promise<void> {
  await redis.set(`ratelimit:user:${userId}`, Date.now().toString());
}

async function markReplyInDM(userId: number): Promise<void> {
  await redis.set(`ratelimit:dm:${userId}`, Date.now().toString());
}

async function canShowCTA(userId: number): Promise<boolean> {
  const key = `cta:cooldown:${userId}`;
  const last = await redis.get(key);
  if (!last) return true;
  
  const elapsed = Date.now() - parseInt(last);
  return elapsed > config.reply.ctaCooldownHours * 3600 * 1000;
}

async function markCTAShown(userId: number): Promise<void> {
  await redis.set(`cta:cooldown:${userId}`, Date.now().toString());
}

// Unique identifier generator for tracking
function generateTrackingId(): string {
  return crypto.randomBytes(4).toString('hex');
}

// ==========================================================
// DISCOVERY FUNCTIONALITY
// ==========================================================

/**
 * Search and discover new Telegram groups/channels based on keywords
 */
async function discoverGroups(client: TelegramClient): Promise<void> {
  console.log(`[${new Date().toISOString()}] Starting group discovery...`);
  let totalDiscovered = 0;

  for (const keyword of config.discovery.keywords) {
    try {
      console.log(`Searching for groups with keyword: ${keyword}`);
      
      // Use Telegram's search function to find public groups/channels
      const result = await client.invoke(new Api.contacts.Search({
        q: keyword,
        limit: config.discovery.maxGroupsPerSearch,
      }));
      
      // Process found chats (groups/channels)
      for (const chat of result.chats) {
        if (!("title" in chat)) continue;
        
        const chatId = chat.id;
        const title = (chat as any).title as string;
        const username = (chat as any).username as string | undefined;
        const isChannel = !!(chat as any).broadcast;
        const memberCount = (chat as any).participantsCount || undefined;
        
        // Skip if contains blacklisted words
        if (config.discovery.blacklistedWords.some(word => 
            title.toLowerCase().includes(word))) {
          continue;
        }
        
        // Skip if too small
        if (memberCount !== undefined && memberCount < config.discovery.minGroupSize) {
          continue;
        }
        
        // Store in database
        try {
          await prisma[config.db.discoveredGroupTable].upsert({
            where: { id: chatId },
            update: {
              lastCheckedAt: new Date(),
              title,
              username,
              memberCount,
            },
            create: {
              id: chatId,
              title,
              username,
              memberCount,
              isChannel,
              discoveredAt: new Date(),
              lastCheckedAt: new Date(),
              keyword,
              isMonitored: false,
            },
          });
          
          // Log discovery
          await prisma[config.db.discoveryLogTable].create({
            data: {
              groupId: chatId,
              title,
              keyword,
              timestamp: new Date(),
              memberCount,
            },
          });
          
          totalDiscovered++;
        } catch (error) {
          console.error(`Error storing discovered group ${chatId}:`, error);
        }
      }
      
      // Don't hit rate limits
      await sleep(2000);
      
    } catch (error) {
      console.error(`Error discovering groups for keyword ${keyword}:`, error);
    }
  }
  
  console.log(`[${new Date().toISOString()}] Discovery complete. Found ${totalDiscovered} new or updated groups.`);
  
  // Notify owner
  if (totalDiscovered > 0) {
    await sendDiscoveryReport(client);
  }
}

/**
 * Send a report of newly discovered groups to the owner
 */
async function sendDiscoveryReport(client: TelegramClient): Promise<void> {
  // Get recently discovered groups
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  
  const groups = await prisma[config.db.discoveredGroupTable].findMany({
    where: {
      OR: [
        { discoveredAt: { gte: yesterday } },
        { lastCheckedAt: { gte: yesterday } }
      ]
    },
    orderBy: { memberCount: 'desc' },
    take: 20,
  });
  
  if (groups.length === 0) return;
  
  // Build report message
  let message = `🔍 **Group Discovery Report**\n\n`;
  message += `Found ${groups.length} new or updated groups:\n\n`;
  
  for (const group of groups) {
    const memberText = group.memberCount ? `(~${group.memberCount} members)` : '';
    const username = group.username ? `@${group.username}` : 'private';
    message += `• ${group.title} - ${username} ${memberText}\n`;
  }
  
  // Add stats
  const totalGroups = await prisma[config.db.discoveredGroupTable].count();
  message += `\nTotal tracked groups: ${totalGroups}\n`;
  message += `\nUse /monitor <group_id> to start monitoring a group.`;
  
  // Send to owner
  await client.sendMessage(config.telegram.ownerChat, { message });
}

/**
 * Handle owner commands for group monitoring
 */
async function handleOwnerCommands(client: TelegramClient, userId: number, text: string): Promise<boolean> {
  // Only process commands from owner
  if (userId !== config.telegram.ownerChat) return false;
  
  // Process commands
  if (text === "/discover_now") {
    await client.sendMessage(userId, { message: "Starting manual group discovery..." });
    await discoverGroups(client);
    return true;
  }
  
  if (text === "/stats") {
    const stats = await generateOwnerStats();
    await client.sendMessage(userId, { message: stats });
    return true;
  }
  
  if (text.startsWith("/monitor ")) {
    const groupId = parseInt(text.split(" ")[1]);
    if (isNaN(groupId)) {
      await client.sendMessage(userId, { message: "Invalid group ID" });
      return true;
    }
    
    // Mark group as monitored
    await prisma[config.db.discoveredGroupTable].update({
      where: { id: groupId },
      data: { isMonitored: true }
    });
    
    await client.sendMessage(userId, { message: `Group ${groupId} is now being monitored.` });
    return true;
  }
  
  if (text === "/leaderboard") {
    const leaderboard = await generateReferralLeaderboard();
    await client.sendMessage(userId, { message: leaderboard });
    return true;
  }
  
  return false;
}

/**
 * Generate stats for the owner
 */
async function generateOwnerStats(): Promise<string> {
  // Get tester count
  const testerCount = await prisma[config.db.testerTable].count();
  
  // Get interaction stats
  const totalReplies = await prisma[config.db.interactionTable].count({
    where: { eventType: "group_reply" }
  });
  
  const totalClicks = await prisma[config.db.interactionTable].count({
    where: { eventType: "click" }
  });
  
  const totalOnboarding = await prisma[config.db.interactionTable].count({
    where: { eventType: "onboarding" }
  });
  
  // Get data source stats
  const dataSourceStats = await prisma[config.db.interactionTable].groupBy({
    by: ["source"],
    _count: { source: true },
    where: { source: { not: null } }
  });
  
  // Get conversion rate
  const conversionRate = totalReplies > 0 
    ? ((totalOnboarding / totalReplies) * 100).toFixed(2) 
    : "0.00";
  
  // Get CTR
  const ctr = totalReplies > 0 
    ? ((totalClicks / totalReplies) * 100).toFixed(2)
    : "0.00";
  
  // Build stats message
  let stats = `📊 **GasGuardian Stats**\n\n`;
  stats += `Beta Testers: ${testerCount}/${config.reply.testingLimit}\n`;
  stats += `Group Replies: ${totalReplies}\n`;
  stats += `Link Clicks: ${totalClicks}\n`;
  stats += `Onboarded Users: ${totalOnboarding}\n\n`;
  stats += `CTR: ${ctr}%\n`;
  stats += `Conversion Rate: ${conversionRate}%\n\n`;
  stats += `**Data Sources:**\n`;
  
  for (const source of dataSourceStats) {
    stats += `${source.source}: ${source._count.source}\n`;
  }
  
  return stats;
}

/**
 * Generate referral leaderboard
 */
async function generateReferralLeaderboard(): Promise<string> {
  // Get top referrers
  const referrers = await prisma[config.db.referralTable].groupBy({
    by: ["referrerId"],
    _count: { referredId: true },
    orderBy: {
      _count: {
        referredId: "desc"
      }
    },
    take: 10
  });
  
  // Build leaderboard message
  let leaderboard = `🏆 **Beta Tester Leaderboard**\n\n`;
  
  if (referrers.length === 0) {
    leaderboard += "No referrals yet.";
    return leaderboard;
  }
  
  for (let i = 0; i < referrers.length; i++) {
    const referrer = referrers[i];
    const tester = await prisma[config.db.testerTable].findUnique({
      where: { tgUserId: referrer.referrerId }
    });
    
    const userName = tester 
      ? `User ${tester.tgUserId}`
      : `Unknown User`;
    
    leaderboard += `${i + 1}. ${userName}: ${referrer._count.referredId} invites\n`;
  }
  
  return leaderboard;
}

// ==========================================================
// A/B TESTING & OPTIMIZATION
// ==========================================================

/**
 * Get the best performing CTA variant or rotate variants
 */
async function getCTAVariant(userId: number): Promise<string> {
  // Get user's variant index based on user ID for consistent experience
  const variantIndex = userId % config.recruitment.ctaVariants.length;
  
  // In production, you would analyze performance and return the best variant
  // For now, we'll just rotate based on user ID
  return config.recruitment.ctaVariants[variantIndex];
}

/**
 * Log A/B test result
 */
async function logABTest(userId: number, variantIndex: number, eventType: string): Promise<void> {
  await prisma[config.db.abTestTable].create({
    data: {
      userId,
      variantIndex,
      eventType,
      timestamp: new Date()
    }
  });
}

/**
 * Calculate A/B test results and optimize
 */
async function analyzeABTestResults(): Promise<void> {
  const variants = config.recruitment.ctaVariants;
  const results = [];
  
  for (let i = 0; i < variants.length; i++) {
    // Count impressions
    const impressions = await prisma[config.db.abTestTable].count({
      where: {
        variantIndex: i,
        eventType: "impression"
      }
    });
    
    // Count clicks
    const clicks = await prisma[config.db.abTestTable].count({
      where: {
        variantIndex: i,
        eventType: "click"
      }
    });
    
    // Count conversions
    const conversions = await prisma[config.db.abTestTable].count({
      where: {
        variantIndex: i,
        eventType: "conversion"
      }
    });
    
    const ctr = impressions > 0 ? (clicks / impressions) * 100 : 0;
    const conversionRate = clicks > 0 ? (conversions / clicks) * 100 : 0;
    
    results.push({
      variant: variants[i],
      impressions,
      clicks,
      conversions,
      ctr,
      conversionRate
    });
  }
  
  // Log results
  console.log("A/B Test Results:", results);
  
  // In a more advanced implementation, we would automatically optimize
  // by updating the variants array based on performance
}

// ==========================================================
// CORE FUNCTIONALITY
// ==========================================================

/**
 * Analyzes a message using GPT-4o to determine language, sentiment, and intent
 */
async function analyzeMessage(text: string): Promise<AnalyzedMessage | null> {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system", 
          content: "Analyze this Telegram message for a crypto bot. Return a JSON object with: " +
                  "isEnglish (boolean), sentiment (number from -1 to 1), " +
                  "intent (one of: gas_complaint, token_inquiry, defi_question, nft_discussion, general_crypto, off_topic), " +
                  "entities.chains (array of chain names mentioned), entities.tokens (array of token symbols mentioned), " +
                  "entities.protocols (array of protocols mentioned), and keywords (array of important words)."
        },
        { role: "user", content: text }
      ],
      response_format: { type: "json_object" },
      temperature: 0.2,
    });
    
    const result = JSON.parse(response.choices[0].message.content) as AnalyzedMessage;
    return result;
  } catch (error) {
    console.error("Error analyzing message:", error);
    return null;
  }
}

/**
 * Generates a Bitly shortlink for tracking
 */
async function generateBitlyLink(userId: number, trackingId: string): Promise<string> {
  try {
    const longUrl = `https://gasguardian.app/invite?uid=${userId}&tid=${trackingId}`;
    
    const response = await axios.post(
      "https://api-ssl.bitly.com/v4/shorten",
      { 
        long_url: longUrl,
        domain: "bit.ly"
      },
      {
        headers: {
          "Authorization": `Bearer ${config.api.bitlyToken}`,
          "Content-Type": "application/json"
        }
      }
    );
    
    return response.data.link;
  } catch (error) {
    console.error("Error generating Bitly link:", error);
    // Fallback to raw URL if Bitly fails
    return `https://gasguardian.app/i/${trackingId}`;
  }
}

/**
 * Log interaction for analytics
 */
async function logInteraction(data: {
  userId: number,
  groupId?: number,
  messageId: number,
  eventType: "group_reply" | "dm_reply" | "click" | "onboarding" | "impression",
  trackingId: string,
  source?: DataSourceType,
  variantIndex?: number,
  meta?: Record<string, any>
}): Promise<void> {
  await prisma[config.db.interactionTable].create({
    data: {
      userId: data.userId,
      groupId: data.groupId,
      messageId: data.messageId,
      eventType: data.eventType,
      trackingId: data.trackingId,
      source: data.source,
      variantIndex: data.variantIndex,
      meta: data.meta || {},
      timestamp: new Date()
    }
  });
}

/**
 * Check if a user is eligible to join the beta test
 */
async function canJoinBeta(): Promise<boolean> {
  const count = await prisma[config.db.testerTable].count();
  return count < config.reply.testingLimit;
}

/**
 * Register a new beta tester
 */
async function registerBetaTester(userId: number, email: string, referrerId?: number): Promise<void> {
  await prisma[config.db.testerTable].create({
    data: {
      tgUserId: userId,
      email,
      referrerId,
      joinedAt: new Date()
    }
  });
  
  // If there's a referrer, update their stats
  if (referrerId) {
    await prisma[config.db.referralTable].create({
      data: {
        referrerId,
        referredId: userId,
        timestamp: new Date()
      }
    });
  }
}

// ==========================================================
// DATA SOURCES
// ==========================================================

/**
 * Fetch gas prices from Blocknative
 */
async function fetchGasPrices(chainId: number): Promise<number | null> {
  try {
    const response = await axios.get(
      `https://api.blocknative.com/gasprices/blockprices?chainid=${chainId}`,
      {
        headers: {
          Authorization: config.api.blocknativeKey
        }
      }
    );
    
    return response.data.blockPrices[0]?.estimatedPrices[0]?.price || null;
  } catch (error) {
    console.error(`Error fetching gas price for chain ${chainId}:`, error);
    return null;
  }
}

/**
 * Fetch mempool data from Bitquery
 */
async function fetchMempoolData(chainId: number): Promise<DataInsight | null> {
  try {
    // Cache key for reducing API calls
    const cacheKey = `mempool:${chainId}`;
    const cached = await redis.get(cacheKey);
    
    if (cached) {
      return JSON.parse(cached) as DataInsight;
    }
    
    // Simplified for brevity - in production would use GraphQL
    const response = await axios.post(
      "https://graphql.bitquery.io",
      {
        query: `
          query {
            ethereum(network: ${chainId === 1 ? "ethereum" : chainId === 56 ? "bsc" : "arbitrum"}) {
              transactions(options: {limit: 5, desc: "value"}) {
                value
                to {
                  address
                }
                from {
                  address
                }
              }
            }
          }
        `
      },
      {
        headers: {
          "X-API-KEY": config.api.bitqueryKey
        }
      }
    );
    
    const txs = response.data.data.ethereum.transactions;
    if (txs && txs.length > 0) {
      const chain = chains.find(c => c.id === chainId);
      const value = parseFloat(txs[0].value) / 1e18;
      
      const insight = {
        text: `${chain?.emoji || "🔄"} Whale alert: ${value.toFixed(1)} ${chain?.symbol || "ETH"} moving on ${chain?.name || "chain"}!`,
        source: DataSourceType.BITQUERY,
        relevanceScore: 0.85,
        timestamp: new Date()
      };
      
      // Cache for 5 minutes
      await redis.set(cacheKey, JSON.stringify(insight), "EX", 300);
      
      return insight;
    }
    return null;
  } catch (error) {
    console.error(`Error fetching mempool data for chain ${chainId}:`, error);
    return null;
  }
}

/**
 * Fetch trending tokens from CoinGecko
 */
async function fetchTrendingTokens(): Promise<DataInsight | null> {
  try {
    // Cache key
    const cacheKey = "trending_tokens";
    const cached = await redis.get(cacheKey);
    
    if (cached) {
      return JSON.parse(cached) as DataInsight;
    }
    
    const response = await axios.get("https://api.coingecko.com/api/v3/search/trending");
    
    if (response.data && response.data.coins && response.data.coins.length > 0) {
      const topCoins = response.data.coins.slice(0, 3)
        .map((coin: any) => coin.item.symbol.toUpperCase())
        .join(", ");
      
      const insight = {
        text: `📈 Trending now: ${topCoins}`,
        source: DataSourceType.COINGECKO,
        relevanceScore: 0.8,
        timestamp: new Date()
      };
      
      // Cache for 15 minutes
      await redis.set(cacheKey, JSON.stringify(insight), "EX", 900);
      
      return insight;
    }
    return null;
  } catch (error) {
    console.error("Error fetching trending tokens:", error);
    // Try to return cached data even if it's expired
    try {
      const cached = await redis.get("trending_tokens");
      if (cached) {
        return JSON.parse(cached) as DataInsight;
      }
    } catch {}
    return null;
  }
}

/**
 * Fetch crypto news from CryptoPanic
 */
async function fetchCryptoNews(): Promise<DataInsight | null> {
  try {
    // Cache key
    const cacheKey = "crypto_news";
    const cached = await redis.get(cacheKey);
    
    if (cached) {
      return JSON.parse(cached) as DataInsight;
    }
    
    const response = await axios.get(
      `https://cryptopanic.com/api/v1/posts/?auth_token=${config.api.cryptoPanicKey}&kind=news`
    );
    
    if (response.data && response.data.results && response.data.results.length > 0) {
      const latestNews = response.data.results[0];
      
      const insight = {
        text: `📰 Breaking: ${latestNews.title.substring(0, 80)}...`,
        source: DataSourceType.CRYPTOPANIC,
        relevanceScore: 0.7,
        timestamp: new Date()
      };
      
      // Cache for 20 minutes
      await redis.set(cacheKey, JSON.stringify(insight), "EX", 1200);
      
      return insight;
    }
    return null;
  } catch (error) {
    console.error("Error fetching crypto news:", error);
    // Try to return cached data even if it's expired
    try {
      const cached = await redis.get("crypto_news");
      if (cached) {
        return JSON.parse(cached) as DataInsight;
      }
    } catch {}
    return null;
  }
}

/**
 * Fetch funding rates from CoinGlass
 */
async function fetchFundingRates(): Promise<DataInsight | null> {
  try {
    // Cache key
    const cacheKey = "funding_rates";
    const cached = await redis.get(cacheKey);
    
    if (cached) {
      return JSON.parse(cached) as DataInsight;
    }
    
    const response = await axios.get(
      "https://open-api.coinglass.com/api/pro/v1/futures/funding_rates_chart",
      {
        headers: {
          "coinglassSecret": config.api.coinglassKey
        },
        params: {
          symbol: "BTC",
          time_type: "h4"
        }
      }
    );
    
    if (response.data && response.data.data) {
      const rates = response.data.data;
      const binanceRate = rates.find((r: any) => r.exchange === "Binance");
      
      if (binanceRate && binanceRate.uMarginList && binanceRate.uMarginList.length > 0) {
        const rate = binanceRate.uMarginList[binanceRate.uMarginList.length - 1];
        const direction = rate > 0 ? "positive" : "negative";
        
        const insight = {
          text: `💹 BTC funding rate ${direction} at ${Math.abs(rate).toFixed(4)}% on Binance`,
          source: DataSourceType.COINGLASS,
          relevanceScore: 0.75,
          timestamp: new Date()
        };
        
        // Cache for 30 minutes
        await redis.set(cacheKey, JSON.stringify(insight), "EX", 1800);
        
        return insight;
      }
    }
    return null;
  } catch (error) {
    console.error("Error fetching funding rates:", error);
    // Try to return cached data even if it's expired
    try {
      const cached = await redis.get("funding_rates");
      if (cached) {
        return JSON.parse(cached) as DataInsight;
      }
    } catch {}
    return null;
  }
}

/**
 * Fetch trending dApps from DappRadar
 */
async function fetchTrendingDapps(): Promise<DataInsight | null> {
  try {
    // Cache key
    const cacheKey = "trending_dapps";
    const cached = await redis.get(cacheKey);
    
    if (cached) {
      return JSON.parse(cached) as DataInsight;
    }
    
    const response = await axios.get(
      "https://api.dappradar.com/4tsxo4vuhotaojtl/dapps",
      {
        params: {
          sort: "users-desc",
          page: 1,
          resultsPerPage: 5
        },
        headers: {
          "X-API-KEY": config.api.dappRadarKey
        }
      }
    );
    
    if (response.data && response.data.results && response.data.results.length > 0) {
      const topDapp = response.data.results[0];
      
      const insight = {
        text: `🔥 ${topDapp.name} is the hottest dApp with ${topDapp.metrics.users_24h.toLocaleString()} users!`,
        source: DataSourceType.DAPPRADAR,
        relevanceScore: 0.7,
        timestamp: new Date()
      };
      
      // Cache for 1 hour
      await redis.set(cacheKey, JSON.stringify(insight), "EX", 3600);
      
      return insight;
    }
    return null;
  } catch (error) {
    console.error("Error fetching trending dApps:", error);
    // Try to return cached data even if it's expired
    try {
      const cached = await redis.get("trending_dapps");
      if (cached) {
        return JSON.parse(cached) as DataInsight;
      }
    } catch {}
    return null;
  }
}

/**
 * Fetch insights based on analyzed message
 */
async function getRelevantInsights(analysis: AnalyzedMessage): Promise<DataInsight[]> {
  const insights: DataInsight[] = [];
  
  // Get chain-specific data if chains are mentioned
  if (analysis.entities.chains.length > 0) {
    const chainName = analysis.entities.chains[0].toLowerCase();
    const chain = chains.find(c => c.name.toLowerCase() === chainName);
    
    if (chain) {
      // If it's a gas complaint, get gas prices
      if (analysis.intent === MessageIntentType.GAS_COMPLAINT) {
        const gas = await fetchGasPrices(chain.id);
        if (gas !== null) {
          insights.push({
            text: `${chain.emoji} ${chain.name} gas: ${gas} gwei`,
            source: DataSourceType.BLOCKNATIVE,
            relevanceScore: 0.9,
            timestamp: new Date()
          });
        }
      }
      
      // Get mempool data for the chain
      const mempoolData = await fetchMempoolData(chain.id);
      if (mempoolData) {
        insights.push(mempoolData);
      }
    }
  }
  
  // Get token data if tokens are mentioned
  if (analysis.entities.tokens.length > 0) {
    const trendingTokens = await fetchTrendingTokens();
    if (trendingTokens) {
      insights.push(trendingTokens);
    }
  }
  
  // Get news if relevant
  if (analysis.intent === MessageIntentType.GENERAL_CRYPTO) {
    const news = await fetchCryptoNews();
    if (news) {
      insights.push(news);
    }
  }
  
  // Get funding rates for trading discussions
  if (analysis.intent === MessageIntentType.TOKEN_INQUIRY || analysis.keywords.includes("trading")) {
    const fundingRates = await fetchFundingRates();
    if (fundingRates) {
      insights.push(fundingRates);
    }
  }
  
  // Get dApp data for DeFi questions
  if (analysis.intent === MessageIntentType.DEFI_QUESTION || analysis.intent === MessageIntentType.NFT_DISCUSSION) {
    const dapps = await fetchTrendingDapps();
    if (dapps) {
      insights.push(dapps);
    }
  }
  
  // Sort by relevance
  return insights.sort((a, b) => b.relevanceScore - a.relevanceScore);
}

/**
 * Generate a reply using GPT-4o and the best insight
 */
async function generateReply(analysis: AnalyzedMessage, insight: DataInsight): Promise<string> {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system", 
          content: "You are GasGuardian, a helpful crypto assistant. Create a short, engaging reply (max 100 chars) " +
                  "using this crypto insight. Be concise, specific, and actionable. No emojis or links."
        },
        { role: "user", content: `Insight: ${insight.text}. User sentiment: ${analysis.sentiment}` }
      ],
      max_tokens: 100,
      temperature: 0.7,
    });
    
    let reply = response.choices[0].message.content?.trim() || insight.text;
    
    // Ensure reply isn't too long
    if (reply.length > 100) {
      reply = reply.substring(0, 97) + "...";
    }
    
    return reply;
  } catch (error) {
    console.error("Error generating reply:", error);
    return insight.text; // Fallback to raw insight
  }
}

/**
 * Format the final reply with optional CTA
 */
async function formatFinalReply(
  userId: number, 
  reply: string, 
  includeCta: boolean
): Promise<{ text: string, trackingId: string, bitlyUrl?: string, variantIndex?: number }> {
  const trackingId = generateTrackingId();
  let finalReply = reply;
  let bitlyUrl: string | undefined;
  let variantIndex: number | undefined;
  
  if (includeCta) {
    // Get the right CTA variant for this user (A/B testing)
    variantIndex = userId % config.recruitment.ctaVariants.length;
    const cta = config.recruitment.ctaVariants[variantIndex];
    
    bitlyUrl = await generateBitlyLink(userId, trackingId);
    finalReply = `${reply}\n\n${cta} ${bitlyUrl}`;
  }
  
  // Ensure we don't exceed max length
  if (finalReply.length > config.reply.maxLength) {
    finalReply = finalReply.substring(0, config.reply.maxLength - 3) + "...";
  }
  
  return { 
    text: finalReply, 
    trackingId,
    bitlyUrl,
    variantIndex
  };
}

// ==========================================================
// MESSAGE HANDLERS
// ==========================================================

/**
 * Handle messages in groups
 */
async function handleGroupMessage(event: NewMessageEvent): Promise<void> {
  const message = event.message;
  const text = message.message;
  const chatId = Number(message.peerId.chatId || message.peerId.channelId);
  const fromId = Number(message.fromId?.userId);
  
  if (!text || !chatId || !fromId) return;

  // Don't process messages from bots or self
  if (event.message.fromId?.className === "PeerUser" && event.message.fromId?.userId === "bot") {
    return;
  }
  
  // Check rate limits
  if (!(await canReplyInGroup(chatId))) return;
  if (!(await canReplyToUser(fromId))) return;
  
  // Analyze the message
  const analysis = await analyzeMessage(text);
  
  // Skip if not English, positive sentiment, or off-topic
  if (!analysis || 
      !analysis.isEnglish || 
      analysis.sentiment > -0.2 || 
      analysis.intent === MessageIntentType.OFF_TOPIC) {
    return;
  }
  
  // Get insights based on message analysis
  const insights = await getRelevantInsights(analysis);
  
  // Skip if no relevant insights
  if (insights.length === 0) {
    return;
  }
  
  // Use best insight
  const bestInsight = insights[0];
  
  // Generate reply based on insight
  const reply = await generateReply(analysis, bestInsight);
  
  // Determine if we should show CTA
  const showCta = 
    analysis.sentiment < -0.5 && // Very negative sentiment
    await canShowCTA(fromId) &&   // Not shown recently
    await canJoinBeta();          // Beta slots available
  
  // Format final reply
  const finalReply = await formatFinalReply(fromId, reply, showCta);
  
  // Send the message
  await client.sendMessage(chatId, { 
    message: finalReply.text,
    replyTo: message.id
  });
  
  // Log interaction
  await logInteraction({
    userId: fromId,
    groupId: chatId,
    messageId: Number(message.id),
    eventType: "group_reply",
    trackingId: finalReply.trackingId,
    source: bestInsight.source,
    variantIndex: finalReply.variantIndex,
    meta: {
      hasCta: showCta,
      sentiment: analysis.sentiment,
      intent: analysis.intent
    }
  });
  
  // If showing CTA, log the impression for A/B testing
  if (showCta && finalReply.variantIndex !== undefined) {
    await logABTest(fromId, finalReply.variantIndex, "impression");
  }
  
  // Mark rate limits
  await markReplyInGroup(chatId);
  await markReplyToUser(fromId);
  
  // If we showed a CTA, mark it
  if (showCta) {
    await markCTAShown(fromId);
  }
}

/**
 * Handle direct messages
 */
async function handleDirectMessage(event: NewMessageEvent): Promise<void> {
  const message = event.message;
  const text = message.message;
  const userId = Number(message.peerId.userId);
  
  if (!text || !userId) return;
  
  // Process owner commands first
  if (await handleOwnerCommands(client, userId, text.trim())) {
    return;
  }
  
  // Rate limit DMs
  if (!(await canReplyInDM(userId))) return;
  
  // User is requesting to join the beta test
  if (text.trim() === "/test" || text.toLowerCase().includes("join beta")) {
    // Check if beta is full
    if (await canJoinBeta()) {
      await client.sendMessage(userId, { 
        message: config.recruitment.betaInstructions
      });
    } else {
      await client.sendMessage(userId, { 
        message: "Sorry, our beta test is currently at capacity. We'll notify you when spots open up!"
      });
    }
    
    // Log the onboarding request
    await logInteraction({
      userId,
      messageId: Number(message.id),
      eventType: "onboarding",
      trackingId: generateTrackingId(),
      meta: { step: "request" }
    });
    
    await markReplyInDM(userId);
    return;
  }
  
  // User is submitting their email for the beta
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (emailRegex.test(text.trim())) {
    // Get referrer from tracking
    const referrerKey = `referrer:${userId}`;
    const referrerId = await redis.get(referrerKey);
    
    // Register the user
    await registerBetaTester(
      userId,
      text.trim(),
      referrerId ? parseInt(referrerId) : undefined
    );
    
    // Confirm registration
    await client.sendMessage(userId, { 
      message: config.recruitment.confirmationMessage
    });
    
    // Log onboarding completion
    await logInteraction({
      userId,
      messageId: Number(message.id),
      eventType: "onboarding",
      trackingId: generateTrackingId(),
      meta: {
        email: text.trim(),
        referrerId: referrerId || null,
        step: "complete"
      }
    });
    
    // Log conversion for A/B testing if we have a variant
    const variantKey = `variant:${userId}`;
    const variantIndex = await redis.get(variantKey);
    if (variantIndex) {
      await logABTest(userId, parseInt(variantIndex), "conversion");
    }
    
    await markReplyInDM(userId);
    return;
  }
  
  // Handle other DM queries with a helpful response
  const analysis = await analyzeMessage(text);
  
  if (!analysis) {
    await client.sendMessage(userId, { 
      message: "I'm GasGuardian, your crypto assistant! Ask about gas prices, trending tokens, or DeFi news."
    });
    await markReplyInDM(userId);
    return;
  }
  
  const insights = await getRelevantInsights(analysis);
  
  if (insights.length === 0) {
    // Fallback if no relevant insights
    await client.sendMessage(userId, { 
      message: "I'm GasGuardian, your crypto assistant! Ask about gas prices, trending tokens, or DeFi news."
    });
  } else {
    // Respond with best insight
    const bestInsight = insights[0];
    await client.sendMessage(userId, { 
      message: bestInsight.text
    });
    
    // Log interaction
    await logInteraction({
      userId,
      messageId: Number(message.id),
      eventType: "dm_reply",
      trackingId: generateTrackingId(),
      source: bestInsight.source
    });
  }
  
  await markReplyInDM(userId);
}

// ==========================================================
// CLICK TRACKING (WEBHOOK HANDLER)
// ==========================================================

/**
 * Process a click on a tracking link
 * This would normally be a webhook endpoint, but we simulate it here
 */
async function processClick(trackingId: string, userId: number): Promise<void> {
  // Log the click
  await logInteraction({
    userId,
    messageId: 0, // Not applicable for clicks
    eventType: "click",
    trackingId
  });
  
  // Store referrer info
  await redis.set(`referrer:${userId}`, userId.toString(), "EX", 604800); // 7 days
  
  // For A/B testing
  const variantIndex = await redis.get(`variant:impression:${trackingId}`);
  if (variantIndex) {
    await logABTest(userId, parseInt(variantIndex), "click");
  }
}

// ==========================================================
// SCHEDULE JOBS
// ==========================================================

/**
 * Setup scheduled jobs
 */
function setupScheduledJobs(client: TelegramClient): void {
  // Group discovery
  schedule.scheduleJob(config.schedules.discoveryTime, async () => {
    await discoverGroups(client);
  });
  
  // Analytics reporting
  schedule.scheduleJob(config.schedules.analyticsTime, async () => {
    // Generate and send analytics report
    const stats = await generateOwnerStats();
    await client.sendMessage(config.telegram.ownerChat, { message: stats });
  });
  
  // Leaderboard
  schedule.scheduleJob(config.schedules.leaderboardTime, async () => {
    // Generate and send leaderboard
    const leaderboard = await generateReferralLeaderboard();
    await client.sendMessage(config.telegram.ownerChat, { message: leaderboard });
  });
  
  // A/B test analysis
  schedule.scheduleJob("0 0 * * 0", async () => {
    // Weekly A/B test analysis
    await analyzeABTestResults();
  });
}

// ==========================================================
// MAIN RUNTIME
// ==========================================================

// Initialize Telegram client
const client = new TelegramClient(
  new StringSession(config.telegram.session),
  config.telegram.apiId,
  config.telegram.apiHash,
  {
    connectionRetries: 5
  }
);

// Main function
async function main() {
  // Start client
  await client.start({
    phoneNumber: async () => "",
    password: async () => "",
    phoneCode: async () => "",
    onError: err => console.error(err)
  });
  
  console.log("GasGuardian userbot started!");
  
  // Set up scheduled jobs
  setupScheduledJobs(client);
  
  // Set up message event handler
  client.addEventHandler(async (event: NewMessageEvent) => {
    try {
      const message = event.message;
      
      // Skip own messages
      if (message.out) return;
      
      // Process direct messages
      if (message.peerId?.className === "PeerUser") {
        await handleDirectMessage(event);
        return;
      }
      
      // Process group messages
      if (message.peerId?.className === "PeerChat" || message.peerId?.className === "PeerChannel") {
        await handleGroupMessage(event);
        return;
      }
    } catch (error) {
      console.error("Error processing message:", error);
    }
  }, new NewMessage({}));
  
  // Run initial discovery
  await discoverGroups(client);
}

// Start the bot
main().catch(console.error);

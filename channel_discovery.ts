export interface Searcher {
  searchChannels(keyword: string): Promise<string[]>;
}

import { enqueueChannel, RedisSetClient } from './queue';
import { getDynamicKeywords } from './keyword-helper';

export const RECRUITMENT_KEYWORDS = [
  // English terms
  'gas fees',
  'cheap gas',
  'gas optimization',
  'defi',
  'nft',
  'airdrop',
  'layer 2',
  'l2',
  // Russian equivalents
  'газовые комиссии',
  'дешевый газ',
  'оптимизация газа',
  'дефи',
  'нфт',
  'эйрдроп',
  'слой 2',
  'л2',
];

export async function discoverChannels(
  searcher: Searcher,
  redis: RedisSetClient,
  keywords: string[] = RECRUITMENT_KEYWORDS,
): Promise<void> {
  const dynamic = await getDynamicKeywords();
  const allKeywords = Array.from(new Set([...keywords, ...dynamic]));
  for (const kw of allKeywords) {
    const channels = await searcher.searchChannels(kw);
    for (const chan of channels) {
      await enqueueChannel(redis, chan);
    }
  }
}

export interface Searcher {
  searchChannels(keyword: string): Promise<string[]>;
}

import { enqueueChannel, RedisSetClient } from './queue';

export const RECRUITMENT_KEYWORDS = ['job', 'hiring', 'career'];

export async function discoverChannels(
  searcher: Searcher,
  redis: RedisSetClient,
  keywords: string[] = RECRUITMENT_KEYWORDS,
): Promise<void> {
  for (const kw of keywords) {
    const channels = await searcher.searchChannels(kw);
    for (const chan of channels) {
      await enqueueChannel(redis, chan);
    }
  }
}

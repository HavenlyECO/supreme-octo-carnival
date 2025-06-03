import { discoverChannels, RECRUITMENT_KEYWORDS, Searcher } from '../channel_discovery';
import { RedisSetClient } from "../queue";


class MockSearcher implements Searcher {
  calls: string[] = [];
  async searchChannels(keyword: string): Promise<string[]> {
    this.calls.push(keyword);
    return [`${keyword}_chan`];
  }
}

class MockRedis implements RedisSetClient {
  processed = new Set<string>();
  pending = new Set<string>();
  async sismember(key: string, value: string): Promise<number> {
    const set = key === 'processed_channels' ? this.processed : this.pending;
    return set.has(value) ? 1 : 0;
  }
  async sadd(key: string, value: string): Promise<number> {
    const set = key === 'processed_channels' ? this.processed : this.pending;
    const sizeBefore = set.size;
    set.add(value);
    return set.size > sizeBefore ? 1 : 0;
  }
}

describe('discoverChannels', () => {
  test('searches each keyword and enqueues results', async () => {
    const searcher = new MockSearcher();
    const redis = new MockRedis();
    await discoverChannels(searcher, redis);
    expect(searcher.calls).toEqual(RECRUITMENT_KEYWORDS);
    expect(redis.pending.size).toBe(RECRUITMENT_KEYWORDS.length);
  });
});

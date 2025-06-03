import { discoverChannels, RECRUITMENT_KEYWORDS, Searcher } from '../channel_discovery';
import { RedisSetClient } from "../queue";


class MockSearcher implements Searcher {
  calls: string[] = [];
  constructor(private results: Record<string, string[]>) {}
  async searchChannels(keyword: string): Promise<string[]> {
    this.calls.push(keyword);
    return this.results[keyword] || [];
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
    const searcher = new MockSearcher({
      job: ['chan1'],
      hiring: ['chan2', 'chan3'],
      career: [],
    });
    const redis = new MockRedis();
    await discoverChannels(searcher, redis);
    expect(searcher.calls).toEqual(RECRUITMENT_KEYWORDS);
    expect(redis.pending.has('chan1')).toBe(true);
    expect(redis.pending.has('chan2')).toBe(true);
    expect(redis.pending.has('chan3')).toBe(true);
  });
});

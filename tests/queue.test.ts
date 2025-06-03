import { enqueueChannel, RedisSetClient } from '../queue';

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

describe('enqueueChannel', () => {
  test('adds channel to pending when not processed', async () => {
    const redis = new MockRedis();
    await enqueueChannel(redis, 'chan1');
    expect(redis.pending.has('chan1')).toBe(true);
  });

  test('does not add channel when already processed', async () => {
    const redis = new MockRedis();
    redis.processed.add('chan2');
    await enqueueChannel(redis, 'chan2');
    expect(redis.pending.has('chan2')).toBe(false);
  });
});

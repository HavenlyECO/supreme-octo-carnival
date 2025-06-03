export interface RedisSetClient {
  sismember(key: string, value: string): Promise<number>;
  sadd(key: string, value: string): Promise<number>;
}

/**
 * Enqueue a channel if it hasn't been processed before.
 * This prevents unnecessary writes when a channel was already handled.
 */
export async function enqueueChannel(
  redis: RedisSetClient,
  channel: string
): Promise<void> {
  const alreadyProcessed = await redis.sismember('processed_channels', channel);
  if (alreadyProcessed === 0) {
    await redis.sadd('pending_channels', channel);
  }
}

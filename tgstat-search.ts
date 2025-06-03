import axios from 'axios';

export async function searchTGStat(keyword: string): Promise<string[]> {
  const token = process.env.TGSTAT_SEARCH_KEY;
  if (!token) throw new Error('TGSTAT_SEARCH_KEY env var not set');

  const url = `https://api.tgstat.ru/channels/search?token=${token}&q=${encodeURIComponent(keyword)}&limit=50`;

  try {
    const resp = await axios.get(url, { timeout: 20000 });
    const items = resp.data?.response?.items ?? [];
    return items
      .map((it: any) => it.username ? `@${it.username}` : null)
      .filter((u: string | null): u is string => !!u);
  } catch (err: any) {
    console.error(`[searchTGStat] Error searching ${keyword}:`, err.message || err);
    return [];
  }
}


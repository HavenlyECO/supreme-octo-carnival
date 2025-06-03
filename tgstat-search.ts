import axios from 'axios';

export async function searchTGStat(keyword: string): Promise<string[]> {
  const token = process.env.TGSTAT_SEARCH_KEY;
  if (!token) throw new Error('TGSTAT_SEARCH_KEY env var not set');

  const url = `https://api.tgstat.ru/channels/search?token=${token}&q=${encodeURIComponent(keyword)}&limit=50`;

  try {
    const resp = await axios.get(url, { timeout: 20000 });
    const items = resp.data?.response?.items ?? [];
    return items
      .map((it: any) => (it.username ? `@${it.username}` : null))
      .filter((u: string | null): u is string => !!u);
  } catch (err: any) {
    console.error(`[searchTGStat] Error searching ${keyword}:`, err.message || err);
    return [];
  }
}

export interface TGStatChannelInfo {
  viewsPerDay: number;
}

export async function fetchTGStatChannelInfo(
  username: string,
): Promise<TGStatChannelInfo | null> {
  const token = process.env.TGSTAT_SEARCH_KEY;
  if (!token) throw new Error('TGSTAT_SEARCH_KEY env var not set');
  const raw = username.replace(/^@/, '');
  const url = `https://api.tgstat.ru/channels/stat?token=${token}&channel=${raw}`;
  try {
    const resp = await axios.get(url, { timeout: 20000 });
    const views = resp.data?.response?.views_per_day;
    if (typeof views === 'number') {
      return { viewsPerDay: views };
    }
    return null;
  } catch (err: any) {
    console.error(
      `[fetchTGStatChannelInfo] Error fetching ${username}:`,
      err.message || err,
    );
    return null;
  }
}

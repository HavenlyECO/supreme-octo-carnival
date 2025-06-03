import { fetchCryptoPanicNews, fetchDappRadarTop } from './external-data';

let cachedKeywords: string[] = [];
let lastFetched = 0;

export function __resetDynamicCache() {
  cachedKeywords = [];
  lastFetched = 0;
}

export async function getDynamicKeywords(): Promise<string[]> {
  const refreshMin = Number(process.env.DYNAMIC_KEYWORD_REFRESH_MINUTES || '60');
  const now = Date.now();
  if (cachedKeywords.length > 0 && now - lastFetched < refreshMin * 60_000) {
    return cachedKeywords;
  }

  try {
    const [newsData, dappData] = await Promise.all([
      fetchCryptoPanicNews(),
      fetchDappRadarTop().catch((err) => {
        console.error('[getDynamicKeywords] Failed to fetch DappRadar:', err.message || err);
        return null;
      }),
    ]);

    const set = new Set<string>();

    for (const item of newsData?.results ?? []) {
      const currencies = (item as any).currencies ?? [];
      for (const cur of currencies) {
        if (cur && typeof cur.code === 'string') {
          set.add(cur.code.toLowerCase());
        }
      }
    }

    const dapps: any[] = (dappData as any)?.dapps ?? (dappData as any)?.results ?? [];
    for (const dapp of dapps) {
      const symbol = (dapp && (dapp.symbol || dapp.token?.symbol)) as string | undefined;
      if (symbol && typeof symbol === 'string') {
        set.add(symbol.toLowerCase());
      }
    }

    cachedKeywords = Array.from(set);
    lastFetched = now;
    return cachedKeywords;
  } catch (err: any) {
    console.error('[getDynamicKeywords] Failed to fetch:', err.message || err);
    return cachedKeywords;
  }
}

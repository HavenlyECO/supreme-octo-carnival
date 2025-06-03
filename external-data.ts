import axios from 'axios';
import { getEnv } from './env-helper';

async function fetchWithRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: any;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      console.error(`[fetchWithRetry] attempt ${i + 1} failed:`, err.message || err);
      if (i < attempts - 1) {
        await new Promise((res) => setTimeout(res, 500));
      }
    }
  }
  throw lastErr;
}

export async function fetchBlocknativeGas() {
  const key = getEnv('BLOCKNATIVE_KEY');
  if (!key) throw new Error('BLOCKNATIVE_KEY not set');
  const resp = await axios.get('https://api.blocknative.com/gasprices/blockprices', {
    headers: { Authorization: key },
    timeout: 10000,
  });
  return resp.data;
}

export async function fetchCryptoPanicNews(attempts = 3) {
  const key = getEnv('CRYPTOPANIC_KEY');
  if (!key) throw new Error('CRYPTOPANIC_KEY not set');
  const url = 'https://cryptopanic.com/api/growth/v2';
  const resp = await fetchWithRetry(
    () =>
      axios.get(url, {
        params: { auth_token: key, kind: 'news', public: true },
        timeout: 10000,
      }),
    attempts,
  );
  return resp.data;
}

export async function fetchDappRadarTop(attempts = 3) {
  const key = getEnv('DAPPRADAR_KEY');
  if (!key) throw new Error('DAPPRADAR_KEY not set');
  const url = 'https://api.dappradar.com/4/dapps';
  const resp = await fetchWithRetry(
    () =>
      axios.get(url, {
        headers: { 'X-BLOBR-KEY': key },
        timeout: 10000,
      }),
    attempts,
  );
  return resp.data;
}

export async function fetchCoinglassOI() {
  const key = getEnv('COINGLASS_KEY');
  if (!key) throw new Error('COINGLASS_KEY not set');
  const resp = await axios.get('https://open-api.coinglass.com/api/pro/v1/futures/openInterest', {
    headers: { coinglassSecret: key },
    timeout: 10000,
  });
  return resp.data;
}

export async function queryBitquery(query: string, variables: any = {}) {
  const key = getEnv('BITQUERY_KEY');
  if (!key) throw new Error('BITQUERY_KEY not set');
  const resp = await axios.post(
    'https://streaming.bitquery.io/graphql',
    { query, variables },
    { headers: { 'X-API-KEY': key }, timeout: 10000 }
  );
  return resp.data;
}

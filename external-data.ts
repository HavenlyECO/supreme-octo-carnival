import axios from 'axios';
import { getEnv } from './env-helper';

export async function fetchBlocknativeGas() {
  const key = getEnv('BLOCKNATIVE_KEY');
  if (!key) throw new Error('BLOCKNATIVE_KEY not set');
  const resp = await axios.get('https://api.blocknative.com/gasprices/blockprices', {
    headers: { Authorization: key },
    timeout: 10000,
  });
  return resp.data;
}

export async function fetchCryptoPanicNews() {
  const key = getEnv('CRYPTOPANIC_KEY');
  if (!key) throw new Error('CRYPTOPANIC_KEY not set');
  const url = 'https://cryptopanic.com/api/v1/posts/';
  const resp = await axios.get(url, {
    params: { auth_token: key, kind: 'news', public: true },
    timeout: 10000,
  });
  return resp.data;
}

export async function fetchDappRadarTop() {
  const key = getEnv('DAPPRADAR_KEY');
  if (!key) throw new Error('DAPPRADAR_KEY not set');
  const resp = await axios.get('https://api.dappradar.com/4/dapps', {
    headers: { 'X-BLOBR-KEY': key },
    timeout: 10000,
  });
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

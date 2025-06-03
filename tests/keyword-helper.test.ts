import { getDynamicKeywords, __resetDynamicCache } from '../keyword-helper';
import { fetchCryptoPanicNews, fetchDappRadarTop } from '../external-data';

jest.mock('../external-data');

const mockedNews = fetchCryptoPanicNews as jest.MockedFunction<typeof fetchCryptoPanicNews>;
const mockedDappRadar = fetchDappRadarTop as jest.MockedFunction<typeof fetchDappRadarTop>;

beforeEach(() => {
  __resetDynamicCache();
  jest.spyOn(Date, 'now').mockReturnValue(0);
  mockedNews.mockResolvedValue({
    results: [
      { currencies: [{ code: 'ETH' }, { code: 'BTC' }] },
      { currencies: [{ code: 'ETH' }, { code: 'MATIC' }] },
    ],
  } as any);
  mockedDappRadar.mockResolvedValue({
    dapps: [
      { symbol: 'ETH' },
      { symbol: 'SOL' },
      { token: { symbol: 'AVAX' } },
    ],
  } as any);
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.resetAllMocks();
});

test('collects unique currency codes from sources', async () => {
  const res = await getDynamicKeywords();
  expect(res).toEqual(['eth', 'btc', 'matic', 'sol', 'avax']);
});

test('uses cached keywords within refresh window', async () => {
  await getDynamicKeywords();
  mockedNews.mockResolvedValue({ results: [{ currencies: [{ code: 'XRP' }] }] } as any);
  mockedDappRadar.mockResolvedValue({ dapps: [{ symbol: 'BNB' }] } as any);
  const res = await getDynamicKeywords();
  expect(res).toEqual(['eth', 'btc', 'matic', 'sol', 'avax']);
  expect(mockedNews).toHaveBeenCalledTimes(1);
  expect(mockedDappRadar).toHaveBeenCalledTimes(1);
});

test('refreshes after refresh window', async () => {
  await getDynamicKeywords();
  mockedNews.mockResolvedValue({ results: [{ currencies: [{ code: 'XRP' }] }] } as any);
  mockedDappRadar.mockResolvedValue({ dapps: [{ symbol: 'BNB' }] } as any);
  (Date.now as jest.Mock).mockReturnValue(1000 * 60 * 61);
  const res = await getDynamicKeywords();
  expect(res).toEqual(['xrp', 'bnb']);
  expect(mockedNews).toHaveBeenCalledTimes(2);
  expect(mockedDappRadar).toHaveBeenCalledTimes(2);
});

test('returns empty array when CryptoPanic fetch fails', async () => {
  mockedNews.mockRejectedValue(new Error('403'));
  const res = await getDynamicKeywords();
  expect(res).toEqual([]);
  expect(mockedNews).toHaveBeenCalledTimes(1);
  expect(mockedDappRadar).toHaveBeenCalledTimes(1);
});

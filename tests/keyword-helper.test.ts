import { getDynamicKeywords, __resetDynamicCache } from '../keyword-helper';
import { fetchCryptoPanicNews } from '../external-data';

jest.mock('../external-data');

const mockedFetch = fetchCryptoPanicNews as jest.MockedFunction<typeof fetchCryptoPanicNews>;

beforeEach(() => {
  __resetDynamicCache();
  jest.spyOn(Date, 'now').mockReturnValue(0);
  mockedFetch.mockResolvedValue({
    results: [
      { currencies: [{ code: 'ETH' }, { code: 'BTC' }] },
      { currencies: [{ code: 'ETH' }, { code: 'MATIC' }] },
    ],
  } as any);
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.resetAllMocks();
});

test('collects unique currency codes from news', async () => {
  const res = await getDynamicKeywords();
  expect(res).toEqual(['eth', 'btc', 'matic']);
});

test('uses cached keywords within refresh window', async () => {
  await getDynamicKeywords();
  mockedFetch.mockResolvedValue({ results: [{ currencies: [{ code: 'SOL' }] }] } as any);
  const res = await getDynamicKeywords();
  expect(res).toEqual(['eth', 'btc', 'matic']);
  expect(mockedFetch).toHaveBeenCalledTimes(1);
});

test('refreshes after refresh window', async () => {
  await getDynamicKeywords();
  mockedFetch.mockResolvedValue({ results: [{ currencies: [{ code: 'SOL' }] }] } as any);
  (Date.now as jest.Mock).mockReturnValue(1000 * 60 * 61);
  const res = await getDynamicKeywords();
  expect(res).toEqual(['sol']);
  expect(mockedFetch).toHaveBeenCalledTimes(2);
});

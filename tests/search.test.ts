import { searchTGStat, fetchTGStatChannelInfo } from '../tgstat-search';
import { searchTelegram } from '../telegram-search';
import axios from 'axios';
import { Api } from 'telegram';

jest.mock('axios');

jest.mock('telegram', () => {
  return {
    Api: {
      contacts: {
        Search: jest.fn(),
      },
      Channel: class Channel {
        constructor(public username: string) {}
      },
    },
  };
});

const mockedAxios = axios as jest.Mocked<typeof axios>;
const mockedInvoke = jest.fn();

describe('searchTGStat', () => {
  test('returns usernames from API', async () => {
    mockedAxios.get.mockResolvedValue({ data: { response: { items: [{ username: 'chan1' }, { username: 'chan2' }] } } });
    const res = await searchTGStat('gas');
    expect(res).toEqual(['@chan1', '@chan2']);
  });
});

describe('fetchTGStatChannelInfo', () => {
  test('returns stats from API', async () => {
    mockedAxios.get.mockResolvedValue({ data: { response: { views_per_day: 800 } } });
    const res = await fetchTGStatChannelInfo('@foo');
    expect(mockedAxios.get).toHaveBeenCalled();
    expect(res).toEqual({ viewsPerDay: 800 });
  });
});

describe('searchTelegram', () => {
  test('collects usernames from Telegram search', async () => {
    mockedInvoke.mockResolvedValue({ chats: [new Api.Channel('foo'), new Api.Channel('bar')] });
    const client = { invoke: mockedInvoke } as any;
    const res = await searchTelegram(client, 'foo');
    expect(mockedInvoke).toHaveBeenCalled();
    expect(res).toEqual(['@foo', '@bar']);
  });
});

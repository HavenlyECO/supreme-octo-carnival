import { TelegramClient, Api } from 'telegram';

export async function searchTelegram(
  client: TelegramClient,
  keyword: string,
): Promise<string[]> {
  try {
    const res = (await client.invoke(
      new Api.contacts.Search({
        q: keyword,
        limit: 50,
        hash: Api.BigInteger.fromValue(0),
      })
    )) as any;
    const names: string[] = [];
    for (const chat of res.chats) {
      if (chat instanceof Api.Channel && chat.username) {
        names.push(`@${chat.username}`);
      }
    }
    return names;
  } catch (err: any) {
    console.error(`[searchTelegram] Error searching "${keyword}":`, err.message || err);
    return [];
  }
}


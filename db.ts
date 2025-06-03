import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();

export async function logChannelSearch(username: string): Promise<void> {
  try {
    await prisma.channelSearch.upsert({
      where: { username },
      create: { username },
      update: { searchedAt: new Date() },
    });
  } catch (err: any) {
    if (err.code === 'P2021' || /does not exist/i.test(err.message)) {
      console.warn('[DB] channelSearch table missing, skipping log');
    } else {
      throw err;
    }
  }
}

export async function channelAlreadySearched(username: string): Promise<boolean> {
  try {
    const existing = await prisma.channelSearch.findUnique({ where: { username } });
    return !!existing;
  } catch (err: any) {
    if (err.code === 'P2021' || /does not exist/i.test(err.message)) {
      console.warn('[DB] channelSearch table missing, assuming not searched');
      return false;
    }
    throw err;
  }
}

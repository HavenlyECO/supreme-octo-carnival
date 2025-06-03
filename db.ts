import { PrismaClient } from '@prisma/client';

let channelSearchReady = false;

async function ensureChannelSearchTable(): Promise<void> {
  if (channelSearchReady) return;
  try {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "channelSearch" (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        "searchedAt" TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    channelSearchReady = true;
  } catch (err) {
    console.warn('[DB] failed to ensure channelSearch table', err);
  }
}

export const prisma = new PrismaClient();

export async function logChannelSearch(username: string): Promise<void> {
  try {
    await ensureChannelSearchTable();
    await prisma.channelSearch.upsert({
      where: { username },
      create: { username },
      update: { searchedAt: new Date() },
    });
  } catch (err: any) {
    if (err.code === 'P2021' || /does not exist/i.test(err.message)) {
      console.warn('[DB] channelSearch table missing, attempting to create');
      await ensureChannelSearchTable();
      await prisma.channelSearch.upsert({
        where: { username },
        create: { username },
        update: { searchedAt: new Date() },
      });
    } else {
      throw err;
    }
  }
}

export async function channelAlreadySearched(username: string): Promise<boolean> {
  try {
    await ensureChannelSearchTable();
    const existing = await prisma.channelSearch.findUnique({ where: { username } });
    return !!existing;
  } catch (err: any) {
    if (err.code === 'P2021' || /does not exist/i.test(err.message)) {
      console.warn('[DB] channelSearch table missing, attempting to create');
      await ensureChannelSearchTable();
      const existing = await prisma.channelSearch.findUnique({ where: { username } });
      return !!existing;
    }
    throw err;
  }
}

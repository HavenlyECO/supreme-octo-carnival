import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();

export async function logChannelSearch(username: string): Promise<void> {
  await prisma.channelSearch.upsert({
    where: { username },
    create: { username },
    update: { searchedAt: new Date() },
  });
}

export async function channelAlreadySearched(username: string): Promise<boolean> {
  const existing = await prisma.channelSearch.findUnique({ where: { username } });
  return !!existing;
}

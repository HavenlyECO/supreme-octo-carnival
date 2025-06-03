// Lightweight DM funnel handler
// Sends gentle CTAs for the /test flow without spamming users

export interface Messenger {
  sendMessage(userId: number, text: string): void;
}

const userStates: Record<number, 'invited' | 'cta_sent' | undefined> = {};

export function handleMessage(
  messenger: Messenger,
  userId: number,
  userMessage: string,
) {
  const text = userMessage.trim().toLowerCase();

  if (text.includes('/test')) {
    messenger.sendMessage(
      userId,
      'Thank you! Check your Gmail for the next steps.',
    );
    userStates[userId] = 'invited';
  } else if (/(?:^|\s)(hello|hi|hey)(?:\s|$)/.test(text)) {
    messenger.sendMessage(
      userId,
      'Hi! Curious about GasGuardian? Send /test whenever you\'re ready.',
    );
    userStates[userId] = 'cta_sent';
  } else if (!userStates[userId]) {
    messenger.sendMessage(
      userId,
      'Interested in opportunities? Reply with /test to learn more!',
    );
    userStates[userId] = 'cta_sent';
  }
}

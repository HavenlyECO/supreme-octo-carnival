export const RELEVANT_KEYWORDS = [
  // English
  "gas",
  "ethereum",
  "eth",
  "polygon",
  "gas fees",
  "defi",
  "transaction",
  "fee",
  "arbitrum",
  "optimism",
  "l2",
  "zksync",
  "starknet",
  "gas optimization",
  "eth gas tracker",
  "cheap gas",
  "gas price",
  "gas monitor",
  "gas analyzer",
  // Russian
  "газ",
  "газовые комиссии",
  "газ эфириум",
  "экономия газа",
  "низкие комиссии",
  "дефи",
  "эфириум",
  "газ трекер",
  "газ прайс",
  "дешевый газ",
  "газ монитор",
  "алгоритм оптимизации",
];

export function containsRelevantKeyword(messages: string[]): boolean {
  const lowerMsgs = messages.map((t) => t.toLowerCase());
  for (const msg of lowerMsgs) {
    for (const kw of RELEVANT_KEYWORDS) {
      if (msg.includes(kw.toLowerCase())) {
        return true;
      }
    }
  }
  return false;
}

export function pickMostRelevantMessage(messages: string[]): string | null {
  for (const text of messages) {
    for (const kw of RELEVANT_KEYWORDS) {
      if (text.toLowerCase().includes(kw.toLowerCase())) {
        return text;
      }
    }
  }
  return null;
}

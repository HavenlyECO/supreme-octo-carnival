import { containsRelevantKeyword, pickMostRelevantMessage } from '../relevance';

describe('containsRelevantKeyword', () => {
  test('returns true when any message contains a keyword', () => {
    const msgs = ['hello', 'cheap gas here'];
    expect(containsRelevantKeyword(msgs)).toBe(true);
  });

  test('returns false when no messages contain keywords', () => {
    const msgs = ['hello', 'world'];
    expect(containsRelevantKeyword(msgs)).toBe(false);
  });
});

describe('pickMostRelevantMessage', () => {
  test('returns the first message containing a keyword', () => {
    const msgs = ['no match', 'gas optimization tips', 'another'];
    expect(pickMostRelevantMessage(msgs)).toBe('gas optimization tips');
  });

  test('returns null when no messages contain a keyword', () => {
    const msgs = ['foo', 'bar'];
    expect(pickMostRelevantMessage(msgs)).toBeNull();
  });

  test('returns first relevant message when multiple contain keywords', () => {
    const msgs = ['gas price is high', 'ethereum rocks'];
    expect(pickMostRelevantMessage(msgs)).toBe('gas price is high');
  });
});

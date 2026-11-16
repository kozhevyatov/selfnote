import { describe, it, expect } from 'vitest';
import { textDiff } from './historyDiff';
describe('Сравнение истории', () => {
  it('сохраняет порядок добавленных, удалённых и общих строк', () => {
    const before = 'Один\nУдалено\nКонец',
      after = 'Один\nДобавлено\nКонец';
    const diff = textDiff(before, after);
    expect(
      diff
        .filter((p) => p.kind !== 'added')
        .map((p) => p.text)
        .join(''),
    ).toBe(before);
    expect(
      diff
        .filter((p) => p.kind !== 'removed')
        .map((p) => p.text)
        .join(''),
    ).toBe(after);
    expect(diff.some((p) => p.kind === 'removed')).toBe(true);
    expect(diff.some((p) => p.kind === 'added')).toBe(true);
  });
  it('сравнивает пустой и большой документ без квадратичного расхода памяти', () => {
    expect(textDiff('', 'Текст')).toEqual([{ kind: 'added', text: 'Текст' }]);
    expect(textDiff('а\n'.repeat(2000), 'б\n'.repeat(2000))).toHaveLength(2);
  });
});

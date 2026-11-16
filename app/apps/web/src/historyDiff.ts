/** Построчный LCS с ограничением памяти для очень больших заметок. */
export function textDiff(
  before: string,
  after: string,
): { kind: 'same' | 'added' | 'removed'; text: string }[] {
  if (before === after) return [{ kind: 'same', text: before }];
  const a = before.match(/[^\n]*\n|[^\n]+$/g) || [];
  const b = after.match(/[^\n]*\n|[^\n]+$/g) || [];
  if (a.length * b.length > 1000000)
    return [
      { kind: 'removed', text: before },
      { kind: 'added', text: after },
    ];
  const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      table[i][j] =
        a[i] === b[j] ? 1 + table[i + 1][j + 1] : Math.max(table[i + 1][j], table[i][j + 1]);
  const result: ReturnType<typeof textDiff> = [];
  let i = 0,
    j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      result.push({ kind: 'same', text: a[i++] });
      j++;
    } else if (i < a.length && (j === b.length || table[i + 1][j] >= table[i][j + 1]))
      result.push({ kind: 'removed', text: a[i++] });
    else result.push({ kind: 'added', text: b[j++] });
  }
  return result;
}

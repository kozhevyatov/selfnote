/** Слова запроса: буквы и цифры, без регистра. */
export function searchTerms(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean),
    ),
  ].slice(0, 8);
}
export interface SnippetPart {
  text: string;
  mark: boolean;
}
/**
 * Фрагмент текста вокруг первого совпадения с подсветкой всех слов запроса
 * (совпадение по началу слова, как в поиске). null — совпадений нет.
 */
export function snippet(text: string, query: string, size = 120): SnippetPart[] | null {
  const terms = searchTerms(query);
  if (!terms.length || !text) return null;
  const flat = text.replace(/\s+/g, ' ');
  const lower = flat.toLowerCase();
  const wordStart = (i: number) => i === 0 || !/[\p{L}\p{N}]/u.test(lower[i - 1]);
  const find = (term: string, from = 0) => {
    for (let i = lower.indexOf(term, from); i >= 0; i = lower.indexOf(term, i + 1))
      if (wordStart(i)) return i;
    return -1;
  };
  const first = Math.min(...terms.map((t) => find(t)).map((i) => (i < 0 ? Infinity : i)));
  if (!Number.isFinite(first)) return null;
  let start = Math.max(0, first - Math.floor(size / 3));
  if (start > 0) {
    const space = flat.indexOf(' ', start);
    if (space >= 0 && space < first) start = space + 1;
  }
  const end = Math.min(flat.length, start + size);
  const ranges: [number, number][] = [];
  for (const term of terms)
    for (let i = find(term, start); i >= 0 && i < end; i = find(term, i + 1))
      ranges.push([i, Math.min(end, i + term.length)]);
  ranges.sort((a, b) => a[0] - b[0]);
  const parts: SnippetPart[] = [];
  let cursor = start;
  if (start > 0) parts.push({ text: '…', mark: false });
  for (const [from, to] of ranges) {
    if (from < cursor) continue;
    if (from > cursor) parts.push({ text: flat.slice(cursor, from), mark: false });
    parts.push({ text: flat.slice(from, to), mark: true });
    cursor = to;
  }
  if (cursor < end) parts.push({ text: flat.slice(cursor, end), mark: false });
  if (end < flat.length) parts.push({ text: '…', mark: false });
  return parts;
}

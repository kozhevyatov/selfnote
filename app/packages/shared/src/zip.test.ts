import { describe, it, expect } from 'vitest';
import { readZip, readZipText, writeZip, crc32, backupsToKeep } from './index.js';

describe('ZIP', () => {
  it('упаковывает и распаковывает текст с кириллицей и бинарные данные', async () => {
    const text = 'Привет, мир! '.repeat(400);
    const bin = new Uint8Array(2000).map((_, i) => (i * 13) % 251);
    const zip = await writeZip([
      { name: 'Книжка/Заметка.md', data: text },
      { name: 'attachments/a.webp', data: bin },
    ]);
    const entries = readZip(zip);
    expect(entries.map((e) => e.name)).toEqual(['Книжка/Заметка.md', 'attachments/a.webp']);
    expect(await readZipText(entries[0])).toBe(text);
    expect(await entries[1].read()).toEqual(bin);
    expect(zip.length).toBeLessThan(text.length);
  });
  it('без сжатия тоже читается', async () => {
    const zip = await writeZip([{ name: 'x.txt', data: 'abc' }], false);
    expect(await readZipText(readZip(zip)[0])).toBe('abc');
  });
  it('считает CRC32 по стандарту', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
  it('отказывается читать не ZIP', () => {
    expect(() => readZip(new Uint8Array(100))).toThrow();
  });
});

describe('Хранение бэкапов', () => {
  it('оставляет 7 последних дней и разреженные недели и месяцы', () => {
    const day = (n: number) => new Date(Date.UTC(2026, 10, 16) - n * 86400000).toISOString();
    const list = Array.from({ length: 300 }, (_, i) => ({ name: `b${i}`, created_at: day(i) }));
    const keep = backupsToKeep(list);
    for (let i = 0; i < 7; i++) expect(keep.has(`b${i}`)).toBe(true);
    expect(keep.has('b299')).toBe(false);
    expect(keep.size).toBeLessThanOrEqual(17);
  });
  it('несколько копий за день — остаётся последняя', () => {
    const keep = backupsToKeep([
      { name: 'early', created_at: '2026-11-16T01:00:00Z' },
      { name: 'late', created_at: '2026-11-16T09:00:00Z' },
    ]);
    expect([...keep]).toEqual(['late']);
  });
});

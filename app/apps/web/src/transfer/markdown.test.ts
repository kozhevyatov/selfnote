import { describe, it, expect } from 'vitest';
import { parseMarkdown, toMarkdown, frontMatter, type PMNode } from './markdown';

describe('Markdown → заметка', () => {
  const md = `---
title: "Переезд на NAS"
tags: [дом, сервер]
pinned: true
---

# Переезд на NAS

Первая строка
вторая с **жирным**, *курсивом*, ~~зачёркнутым~~ и ||секретом||.

- [x] Бэкап базы
- [ ] Перенести Gitea 📅 2026-11-20
  - вложенный пункт

1. раз
2. два

![фото](attachments/1.webp) #важное

\`\`\`
код **не трогаем**
\`\`\`
`;
  const r = parseMarkdown(md);
  it('читает front matter, заголовок и метки', () => {
    expect(r.meta.title).toBe('Переезд на NAS');
    expect(r.meta.pinned).toBe(true);
    expect(r.title).toBe('Переезд на NAS');
    expect([...r.tags].sort()).toEqual(['важное', 'дом', 'сервер']);
    expect(r.images).toEqual(['attachments/1.webp']);
  });
  it('сохраняет переносы строк и оформление', () => {
    expect(r.html).toContain(
      '<p>Первая строка<br>вторая с <strong>жирным</strong>, <em>курсивом</em>, <s>зачёркнутым</s> и <span data-spoiler="">секретом</span>.</p>',
    );
  });
  it('превращает чек-лист в задачи со сроком и вложенностью', () => {
    expect(r.html).toContain('<li data-type="taskItem" data-checked="true"><p>Бэкап базы</p>');
    expect(r.html).toContain(
      'data-checked="false" due="2026-11-20"><p>Перенести Gitea</p><ul><li><p>вложенный пункт</p></li></ul></li></ul>',
    );
    expect(r.html).toContain('<ol><li><p>раз</p></li><li><p>два</p></li></ol>');
  });
  it('не трогает разметку внутри блока кода', () => {
    expect(r.html).toContain('<pre><code>код **не трогаем**</code></pre>');
  });
});

describe('заметка → Markdown → заметка', () => {
  const doc: PMNode = {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Заголовок' }] },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'жир', marks: [{ type: 'bold' }] },
          { type: 'text', text: ' и ' },
          { type: 'text', text: 'тайна', marks: [{ type: 'spoiler' }] },
          { type: 'hardBreak' },
          { type: 'text', text: 'строка 2' },
        ],
      },
      {
        type: 'taskList',
        content: [
          {
            type: 'taskItem',
            attrs: { checked: true, due: '2026-11-20' },
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Сделать' }] }],
          },
        ],
      },
    ],
  };
  const out = toMarkdown(doc, () => '');
  it('экспортирует в Markdown, понятный Obsidian', () => {
    expect(out).toContain('## Заголовок');
    expect(out).toContain('**жир** и ||тайна||  \nстрока 2');
    expect(out).toContain('- [x] Сделать 📅 2026-11-20');
  });
  it('при обратном импорте задачи, сроки и спойлер сохраняются', () => {
    const back = parseMarkdown(frontMatter({ title: 'X' }) + out);
    expect(back.html).toContain('data-checked="true" due="2026-11-20"><p>Сделать</p>');
    expect(back.html).toContain('<span data-spoiler="">тайна</span>');
  });
});

/**
 * Документ заметки (Y.XmlFragment в схеме TipTap) → безопасный HTML.
 * Используется публичной страницей: сервером для обычных заметок и браузером —
 * для заметок под паролем, которые сервер прочитать не может.
 */
import * as Y from 'yjs';
import { dueDay } from './dates.js';
import { repeatLabel } from './repeat.js';

/** Палитра цвета текста и подложки: в документе хранится имя, оттенок задаёт CSS темы. */
export const NOTE_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray'] as const;
export type NoteColor = (typeof NOTE_COLORS)[number];
const noteColor = (value: unknown): NoteColor | null =>
  typeof value === 'string' && (NOTE_COLORS as readonly string[]).includes(value)
    ? (value as NoteColor)
    : null;
export interface RenderOptions {
  /** Адрес картинки для публичной страницы; null — картинку пропустить. */
  image?: (src: string) => string | null;
  /** Сегодняшняя дата YYYY-MM-DD — для подписи просроченных сроков. */
  today?: string;
}
export interface Rendered {
  html: string;
  text: string;
  images: string[];
}
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function safeHref(href: unknown): string | null {
  if (typeof href !== 'string') return null;
  return /^(https?:\/\/|mailto:)/i.test(href.trim()) ? href.trim() : null;
}
const MONTHS = [
  'янв.',
  'февр.',
  'мар.',
  'апр.',
  'мая',
  'июн.',
  'июл.',
  'авг.',
  'сент.',
  'окт.',
  'нояб.',
  'дек.',
];
function dueText(due: string, today?: string) {
  const day = dueDay(due);
  const [, m, d] = day.split('-').map(Number);
  const label = `${d} ${MONTHS[m - 1]}`;
  if (today && day === today) return { label: 'Сегодня', state: 'today' };
  if (today && day < today) return { label: `Просрочено · ${label}`, state: 'overdue' };
  return { label, state: '' };
}
type Delta = { insert: unknown; attributes?: Record<string, Record<string, unknown> | null> };
function inline(text: Y.XmlText): { html: string; text: string } {
  let html = '';
  let plain = '';
  for (const part of text.toDelta() as Delta[]) {
    if (typeof part.insert !== 'string') continue;
    plain += part.insert;
    let piece = escapeHtml(part.insert).replace(/\n/g, '<br>');
    const marks = part.attributes ?? {};
    if (marks.code) piece = `<code>${piece}</code>`;
    if (marks.bold) piece = `<strong>${piece}</strong>`;
    if (marks.italic) piece = `<em>${piece}</em>`;
    if (marks.strike) piece = `<s>${piece}</s>`;
    if (marks.underline) piece = `<u>${piece}</u>`;
    const color = noteColor(marks.textColor?.color);
    if (color) piece = `<span class="text-color-${color}">${piece}</span>`;
    if (marks.highlight)
      piece = `<mark class="highlight-${noteColor(marks.highlight.color) ?? 'yellow'}">${piece}</mark>`;
    if (marks.spoiler)
      piece = `<span class="spoiler" data-spoiler tabindex="0" role="button" aria-label="Показать скрытый текст">${piece}</span>`;
    const href = safeHref(marks.link?.href);
    if (href)
      piece = `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer nofollow ugc">${piece}</a>`;
    html += piece;
  }
  return { html, text: plain };
}
export function renderDocument(fragment: Y.XmlFragment, options: RenderOptions = {}): Rendered {
  const images: string[] = [];
  const texts: string[] = [];
  function children(node: Y.XmlFragment | Y.XmlElement): string {
    return node
      .toArray()
      .map((child) => {
        if (child instanceof Y.XmlText) {
          const r = inline(child);
          texts.push(r.text);
          return r.html;
        }
        return child instanceof Y.XmlElement ? element(child) : '';
      })
      .join('');
  }
  function block(tag: string, node: Y.XmlElement, attrs = '') {
    const html = `<${tag}${attrs}>${children(node)}</${tag}>`;
    texts.push('\n');
    return html;
  }
  function element(node: Y.XmlElement): string {
    const attrs = node.getAttributes() as Record<string, unknown>;
    switch (node.nodeName) {
      case 'paragraph':
        return block('p', node);
      case 'heading':
        return block(Number(attrs.level) === 3 ? 'h3' : 'h2', node);
      case 'blockquote':
        return block('blockquote', node);
      case 'codeBlock':
        return `<pre><code>${children(node)}</code></pre>`;
      case 'bulletList':
        return `<ul>${children(node)}</ul>`;
      case 'orderedList': {
        const start = Number(attrs.start);
        return `<ol${start > 1 ? ` start="${start}"` : ''}>${children(node)}</ol>`;
      }
      case 'listItem':
        return `<li>${children(node)}</li>`;
      case 'taskList':
        return `<ul class="task-list">${children(node)}</ul>`;
      case 'taskItem': {
        const checked = attrs.checked === true || attrs.checked === 'true';
        const due =
          typeof attrs.due === 'string' && attrs.due ? dueText(attrs.due, options.today) : null;
        const repeat = repeatLabel(attrs.repeat);
        const meta = [
          due && !checked ? `<span class="due ${due.state}">${escapeHtml(due.label)}</span>` : '',
          repeat && !checked ? `<span class="repeat">${escapeHtml(repeat)}</span>` : '',
        ].join('');
        return `<li class="task${checked ? ' checked' : ''}"><span class="box" aria-hidden="true"></span><span class="sr-only">${checked ? 'Выполнено: ' : 'Не выполнено: '}</span><div class="task-content">${children(node)}</div>${meta}</li>`;
      }
      case 'horizontalRule':
        return '<hr>';
      case 'hardBreak':
        texts.push('\n');
        return '<br>';
      case 'image': {
        const src = typeof attrs.src === 'string' ? attrs.src : '';
        if (src) images.push(src);
        const url = options.image ? options.image(src) : null;
        if (!url) return '';
        const alt = typeof attrs.alt === 'string' ? attrs.alt : 'Изображение';
        return `<figure><img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}" loading="lazy"></figure>`;
      }
      default:
        return children(node);
    }
  }
  const html = children(fragment);
  return {
    html,
    text: texts
      .join('')
      .replace(/\n{2,}/g, '\n')
      .trim(),
    images,
  };
}

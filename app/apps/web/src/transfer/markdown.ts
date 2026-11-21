/**
 * Markdown ⇄ документ заметки.
 * Экспорт: JSON ProseMirror → Markdown (совместим с Obsidian; спойлер — ||текст||,
 * срок задачи — «📅 ГГГГ-ММ-ДД»). Импорт: Markdown → HTML, который понимает редактор.
 */
export interface PMNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

// ---------- экспорт ----------
function inline(nodes: PMNode[] = [], image: (src: string, alt: string) => string): string {
  let out = '';
  for (const node of nodes) {
    if (node.type === 'hardBreak') {
      out += '  \n';
      continue;
    }
    if (node.type === 'image') {
      out += image(String(node.attrs?.src ?? ''), String(node.attrs?.alt ?? ''));
      continue;
    }
    let text = (node.text ?? '').replace(/([\\`*_~|[\]])/g, '\\$1');
    const marks = new Set((node.marks ?? []).map((m) => m.type));
    if (marks.has('code')) text = '`' + (node.text ?? '') + '`';
    if (marks.has('bold')) text = `**${text}**`;
    if (marks.has('italic')) text = `*${text}*`;
    if (marks.has('strike')) text = `~~${text}~~`;
    if (marks.has('spoiler')) text = `||${text}||`;
    // выделение — как в Obsidian; цвет текста в Markdown не переносится
    if (marks.has('highlight')) text = `==${text}==`;
    const link = node.marks?.find((m) => m.type === 'link');
    if (link) text = `[${text}](${String(link.attrs?.href ?? '')})`;
    out += text;
  }
  return out;
}
function block(node: PMNode, indent: string, image: (src: string, alt: string) => string): string {
  const children = node.content ?? [];
  switch (node.type) {
    case 'paragraph':
      return indent + inline(children, image).replace(/\n/g, '\n' + indent);
    case 'heading':
      return '#'.repeat(Number(node.attrs?.level ?? 2)) + ' ' + inline(children, image);
    case 'blockquote':
      return children
        .map((c) => block(c, '', image))
        .join('\n\n')
        .split('\n')
        .map((l) => indent + '> ' + l)
        .join('\n');
    case 'codeBlock':
      return `${indent}\`\`\`${String(node.attrs?.language ?? '')}\n${children.map((c) => c.text ?? '').join('')}\n${indent}\`\`\``;
    case 'horizontalRule':
      return indent + '---';
    case 'image':
      return indent + image(String(node.attrs?.src ?? ''), String(node.attrs?.alt ?? ''));
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      return children
        .map((item, i) => {
          const [first, ...rest] = item.content ?? [];
          let marker = '- ';
          if (node.type === 'orderedList') marker = `${Number(node.attrs?.start ?? 1) + i}. `;
          if (node.type === 'taskList') marker = item.attrs?.checked ? '- [x] ' : '- [ ] ';
          let line = indent + marker + (first ? block(first, '', image) : '');
          const due = item.attrs?.due;
          if (node.type === 'taskList' && typeof due === 'string' && due)
            line += ` 📅 ${due.slice(0, 10)}`;
          const nested = rest.map((c) => block(c, indent + '  ', image));
          return [line, ...nested].join('\n');
        })
        .join('\n');
    default:
      return children.map((c) => block(c, indent, image)).join('\n\n');
  }
}
export function toMarkdown(doc: PMNode, image: (src: string, alt: string) => string): string {
  return (doc.content ?? [])
    .map((n) => block(n, '', image))
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function frontMatter(fields: Record<string, unknown>): string {
  const lines = Object.entries(fields)
    .filter(
      ([, v]) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length),
    )
    .map(([k, v]) =>
      Array.isArray(v)
        ? `${k}: [${v.map((x) => JSON.stringify(String(x))).join(', ')}]`
        : `${k}: ${typeof v === 'string' ? JSON.stringify(v) : String(v)}`,
    );
  return lines.length ? `---\n${lines.join('\n')}\n---\n\n` : '';
}

// ---------- импорт ----------
export interface ParsedMarkdown {
  meta: Record<string, string | string[] | boolean>;
  html: string;
  tags: string[];
  images: string[];
  title?: string;
}
const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function parseFrontMatter(text: string) {
  const meta: Record<string, string | string[] | boolean> = {};
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { meta, body: text };
  let listKey = '';
  for (const raw of match[1].split(/\r?\n/)) {
    const item = /^\s*-\s+(.*)$/.exec(raw);
    if (item && listKey) {
      (meta[listKey] as string[]).push(unquote(item[1]));
      continue;
    }
    const kv = /^([\w-]+):\s*(.*)$/.exec(raw);
    if (!kv) continue;
    const [, key, value] = kv;
    listKey = '';
    if (value === '') {
      meta[key] = [];
      listKey = key;
    } else if (/^\[.*\]$/.test(value))
      meta[key] = value
        .slice(1, -1)
        .split(',')
        .map((v) => unquote(v.trim()))
        .filter(Boolean);
    else if (value === 'true' || value === 'false') meta[key] = value === 'true';
    else meta[key] = unquote(value);
  }
  return { meta, body: text.slice(match[0].length) };
}
function unquote(v: string) {
  const t = v.trim();
  if (/^".*"$/.test(t)) {
    try {
      return JSON.parse(t) as string;
    } catch {
      return t.slice(1, -1);
    }
  }
  return t.replace(/^'(.*)'$/, '$1');
}

function inlineHtml(text: string, images: string[], tags: Set<string>): string {
  const codes: string[] = [];
  let s = text.replace(/`([^`]+)`/g, (_, c: string) => {
    codes.push(`<code>${escapeHtml(c)}</code>`);
    return `\uE000${codes.length - 1}\uE000`;
  });
  s = escapeHtml(s);
  // ![[file.png]] (Obsidian) и ![alt](path)
  s = s.replace(/!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, (_, file: string) => {
    images.push(file.trim());
    return `<img src="${escapeHtml(file.trim())}" alt="">`;
  });
  s = s.replace(
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g,
    (_, alt: string, src: string) => {
      const path = decodeURI(src.replace(/^<|>$/g, ''));
      images.push(path);
      return `<img src="${escapeHtml(path)}" alt="${alt}">`;
    },
  );
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
  s = s.replace(
    /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
    (_, target: string, label?: string) => label || target,
  );
  s = s.replace(
    /\*\*(.+?)\*\*|__(.+?)__/g,
    (_, a?: string, b?: string) => `<strong>${a ?? b}</strong>`,
  );
  s = s.replace(/(^|[^*\w])\*(?!\s)(.+?)\*(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_\w])_(?!\s)(.+?)_(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/~~(.+?)~~/g, '<s>$1</s>');
  s = s.replace(/\|\|(.+?)\|\|/g, '<span data-spoiler="">$1</span>');
  s = s.replace(/==(.+?)==/g, '<mark data-highlight="yellow">$1</mark>');
  s = s.replace(/(^|\s)#([\p{L}\p{N}_/-]+)/gu, (all, pre: string, tag: string) => {
    if (/^\d+$/.test(tag)) return all;
    tags.add(tag);
    return `${pre}#${tag}`;
  });
  s = s.replace(/\\([\\`*_~|[\]#])/g, '$1');
  return s.replace(/\uE000(\d+)\uE000/g, (_, i: string) => codes[Number(i)]);
}

interface ListFrame {
  indent: number;
  type: 'ul' | 'ol' | 'task';
}
export function parseMarkdown(text: string): ParsedMarkdown {
  const { meta, body } = parseFrontMatter(text.replace(/^\uFEFF/, ''));
  const images: string[] = [];
  const tags = new Set<string>();
  const out: string[] = [];
  const lines = body.split(/\r?\n/);
  let paragraph: string[] = [];
  const lists: ListFrame[] = [];
  let title: string | undefined;
  const flushParagraph = () => {
    if (paragraph.length)
      out.push(`<p>${paragraph.map((l) => inlineHtml(l, images, tags)).join('<br>')}</p>`);
    paragraph = [];
  };
  const closeLists = (toIndent = -1) => {
    while (lists.length && lists[lists.length - 1].indent > toIndent) {
      const frame = lists.pop()!;
      out.push(frame.type === 'ol' ? '</li></ol>' : '</li></ul>');
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^(\s*)```(\w*)/.exec(line);
    if (fence) {
      flushParagraph();
      closeLists();
      const code: string[] = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i]);
      out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      if (!/^\s*([-*+]|\d+[.)])\s/.test(lines[i + 1] ?? '')) closeLists();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      closeLists();
      const level = heading[1].length;
      if (level === 1 && title === undefined && !out.length) {
        title = heading[2].trim();
        continue;
      }
      const tag = level <= 2 ? 'h2' : 'h3';
      out.push(`<${tag}>${inlineHtml(heading[2], images, tags)}</${tag}>`);
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushParagraph();
      closeLists();
      out.push('<hr>');
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      flushParagraph();
      closeLists();
      const quoted = [quote[1]];
      while (i + 1 < lines.length && /^\s*>/.test(lines[i + 1]))
        quoted.push(lines[++i].replace(/^\s*>\s?/, ''));
      out.push(
        `<blockquote><p>${quoted.map((l) => inlineHtml(l, images, tags)).join('<br>')}</p></blockquote>`,
      );
      continue;
    }
    const item = /^(\s*)([-*+]|\d+[.)])\s+(\[( |x|X)\]\s+)?(.*)$/.exec(line);
    if (item) {
      flushParagraph();
      const indent = item[1].replace(/\t/g, '  ').length;
      const type: ListFrame['type'] =
        item[4] !== undefined ? 'task' : /\d/.test(item[2]) ? 'ol' : 'ul';
      let content = item[5];
      const top = lists[lists.length - 1];
      if (top && indent > top.indent) {
        lists.push({ indent, type });
        out.push(type === 'ol' ? '<ol>' : type === 'task' ? '<ul data-type="taskList">' : '<ul>');
      } else {
        closeLists(indent);
        const current = lists[lists.length - 1];
        if (current && current.indent === indent && current.type === type) out.push('</li>');
        else {
          if (current && current.indent === indent) closeLists(indent - 1);
          lists.push({ indent, type });
          out.push(type === 'ol' ? '<ol>' : type === 'task' ? '<ul data-type="taskList">' : '<ul>');
        }
      }
      if (type === 'task') {
        let due = '';
        content = content.replace(/\s*(?:📅|🗓️?|due:)\s*(\d{4}-\d{2}-\d{2})/u, (_, d: string) => {
          due = d;
          return '';
        });
        const checked = item[4].toLowerCase() === 'x';
        out.push(
          `<li data-type="taskItem" data-checked="${checked}"${due ? ` due="${due}"` : ''}><p>${inlineHtml(content, images, tags)}</p>`,
        );
      } else out.push(`<li><p>${inlineHtml(content, images, tags)}</p>`);
      continue;
    }
    if (lists.length && /^\s{2,}\S/.test(line)) {
      out.push(`<p>${inlineHtml(line.trim(), images, tags)}</p>`);
      continue;
    }
    closeLists();
    paragraph.push(line);
  }
  flushParagraph();
  closeLists();
  const metaTags = meta.tags;
  for (const t of Array.isArray(metaTags)
    ? metaTags
    : typeof metaTags === 'string'
      ? metaTags.split(/[,\s]+/)
      : [])
    if (t) tags.add(t.replace(/^#/, ''));
  return { meta, html: out.join(''), tags: [...tags], images, title };
}

/**
 * Импорт заметок: Synology Note Station (.nsx), Markdown (.md или ZIP с папками,
 * в т. ч. экспорт Obsidian) и полная копия SelfNote (.zip из «Экспорта»).
 * Заметки создаются как обычные Yjs-документы — сразу синхронизируются на все устройства.
 */
import { generateJSON, getSchema } from '@tiptap/core';
import { prosemirrorJSONToYXmlFragment } from '@tiptap/y-tiptap';
import { readZip, readZipText, type ZipEntry } from '@selfnote/shared';
import { contentExtensions } from '../Editor';
import { storeImage, flushImages } from '../attachments';
import type { Workspace } from '../store';
import { uuid } from '../ids';
import { normalizeHtml, type NormalizeStats } from './html';
import { parseMarkdown, type PMNode } from './markdown';

export type ImportKind = 'nsx' | 'markdown' | 'selfnote';
export interface ImportNote {
  title: string;
  html?: string;
  json?: PMNode;
  tags: string[];
  book: string | null;
  section: string | null;
  bookColor?: string;
  updatedAt?: string;
  pinned?: boolean;
  source: string;
  /** Картинки по значению src в html/json. */
  images: Map<string, Blob>;
}
export interface ImportPlan {
  kind: ImportKind;
  fileName: string;
  notes: ImportNote[];
  books: string[];
  skipped: { title: string; reason: string }[];
  warnings: string[];
}
export interface ImportReport {
  notes: number;
  books: number;
  sections: number;
  tasks: number;
  images: number;
  duplicates: number;
  skipped: { title: string; reason: string }[];
  warnings: string[];
}

const IMAGE_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  heic: 'image/heic',
  svg: 'image/svg+xml',
};
const extOf = (name: string) => name.split('.').pop()?.toLowerCase() ?? '';
const mimeOf = (name: string, fallback = '') => IMAGE_EXT[extOf(name)] ?? fallback;
const isImage = (name: string, type = '') => type.startsWith('image/') || extOf(name) in IMAGE_EXT;
function hash(text: string) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
function normalizePath(path: string) {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

// ---------- чтение файла ----------
export async function readImportFile(file: File): Promise<ImportPlan> {
  const name = file.name;
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (/\.(md|markdown|txt)$/i.test(name)) {
    const text = new TextDecoder().decode(bytes);
    return planMarkdown(name, [{ path: name, text, date: new Date(file.lastModified) }], new Map());
  }
  let entries: ZipEntry[];
  try {
    entries = readZip(bytes);
  } catch {
    throw new Error('Не удалось прочитать файл: поддерживаются .nsx, .zip и .md');
  }
  const names = new Set(entries.map((e) => e.name));
  if (names.has('selfnote.json')) return planSelfnote(name, entries);
  if (names.has('config.json') || /\.nsx$/i.test(name)) return planNsx(name, entries);
  const byPath = new Map(entries.map((e) => [normalizePath(e.name), e]));
  const files: { path: string; text: string; date: Date }[] = [];
  for (const e of entries)
    if (/\.(md|markdown)$/i.test(e.name) && !e.name.split('/').some((p) => p.startsWith('.')))
      files.push({ path: normalizePath(e.name), text: await readZipText(e), date: e.date });
  if (!files.length)
    throw new Error('В архиве нет заметок: ни .nsx, ни Markdown, ни копии SelfNote');
  return planMarkdown(name, files, byPath);
}

// ---------- Synology Note Station ----------
interface NsxAttachment {
  md5?: string;
  name?: string;
  type?: string;
  ref?: string;
}
async function planNsx(fileName: string, entries: ZipEntry[]): Promise<ImportPlan> {
  const byName = new Map(entries.map((e) => [e.name, e]));
  const configEntry = byName.get('config.json');
  if (!configEntry) throw new Error('В архиве Note Station нет config.json');
  const config = JSON.parse(await readZipText(configEntry)) as {
    note?: string[];
    notebook?: string[];
  };
  const plan: ImportPlan = {
    kind: 'nsx',
    fileName,
    notes: [],
    books: [],
    skipped: [],
    warnings: [],
  };
  const books = new Map<string, { title: string; stack: string }>();
  for (const id of config.notebook ?? []) {
    const entry = byName.get(id);
    if (!entry) continue;
    const nb = JSON.parse(await readZipText(entry)) as { title?: string; stack?: string };
    books.set(id, { title: nb.title?.trim() || 'Без названия', stack: nb.stack?.trim() || '' });
  }
  const bookNames = new Set<string>();
  for (const id of config.note ?? []) {
    const entry = byName.get(id);
    if (!entry) {
      plan.skipped.push({ title: id, reason: 'нет файла заметки в архиве' });
      continue;
    }
    const n = JSON.parse(await readZipText(entry)) as {
      title?: string;
      content?: string;
      parent_id?: string;
      tag?: string[];
      mtime?: number;
      ctime?: number;
      encrypt?: boolean;
      attachment?: Record<string, NsxAttachment> | null;
    };
    const title = n.title?.trim() || 'Без названия';
    if (n.encrypt) {
      plan.skipped.push({
        title,
        reason: 'зашифрована паролем Note Station — расшифруйте её там и выгрузите снова',
      });
      continue;
    }
    const nb = n.parent_id ? books.get(n.parent_id) : undefined;
    const book = nb ? nb.stack || nb.title : 'Note Station';
    const section = nb?.stack ? nb.title : null;
    bookNames.add(book);
    const images = new Map<string, Blob>();
    const byRef = new Map<string, string>();
    const byFile = new Map<string, string>();
    for (const a of Object.values(n.attachment ?? {})) {
      const fileEntry = a.md5 ? byName.get(`file_${a.md5}`) : undefined;
      const label = a.name || 'вложение';
      if (!fileEntry) {
        plan.warnings.push(`«${title}»: «${label}» отсутствует в архиве`);
        continue;
      }
      if (!isImage(label, a.type)) {
        plan.warnings.push(
          `«${title}»: файл «${label}» не перенесён — поддерживаются только картинки`,
        );
        continue;
      }
      const key = `nsx:${a.md5}`;
      images.set(
        key,
        new Blob([new Uint8Array(await fileEntry.read())], {
          type: a.type || mimeOf(label, 'image/png'),
        }),
      );
      if (a.ref) byRef.set(a.ref, key);
      byFile.set(label, key);
    }
    // Картинки Note Station ссылаются на вложение атрибутом ref; подставляем наш ключ.
    const dom = new DOMParser().parseFromString(`<body>${n.content ?? ''}</body>`, 'text/html');
    const used = new Set<string>();
    for (const img of [...dom.body.querySelectorAll('img')]) {
      const ref = img.getAttribute('ref');
      const src = img.getAttribute('src') ?? '';
      const key =
        (ref && byRef.get(ref)) || byFile.get(decodeURIComponent(src.split('/').pop() ?? ''));
      if (key) {
        img.setAttribute('src', key);
        used.add(key);
      } else img.remove();
    }
    for (const key of images.keys())
      if (!used.has(key)) {
        const p = dom.createElement('p');
        const img = dom.createElement('img');
        img.setAttribute('src', key);
        p.appendChild(img);
        dom.body.appendChild(p);
      }
    const seconds = n.mtime || n.ctime;
    plan.notes.push({
      title,
      html: dom.body.innerHTML,
      tags: (n.tag ?? []).map((t) => String(t).trim()).filter(Boolean),
      book,
      section,
      updatedAt: seconds ? new Date(seconds * 1000).toISOString() : undefined,
      source: `nsx:${id}`,
      images,
    });
  }
  plan.books = [...bookNames];
  return plan;
}

// ---------- Markdown ----------
async function planMarkdown(
  fileName: string,
  files: { path: string; text: string; date: Date }[],
  archive: Map<string, ZipEntry>,
): Promise<ImportPlan> {
  const plan: ImportPlan = {
    kind: 'markdown',
    fileName,
    notes: [],
    books: [],
    skipped: [],
    warnings: [],
  };
  const byBase = new Map<string, ZipEntry>();
  for (const [path, entry] of archive) byBase.set(path.split('/').pop()!.toLowerCase(), entry);
  // Если всё лежит в одной общей папке архива — она не книжка, а обёртка.
  const dirs = files.map((f) => f.path.split('/').slice(0, -1));
  const wrapper = archive.size && dirs.every((d) => d.length > 0 && d[0] === dirs[0][0]) ? 1 : 0;
  const bookNames = new Set<string>();
  for (const file of files) {
    const parsed = parseMarkdown(file.text);
    const parts = file.path.split('/');
    const folders = parts.slice(wrapper, -1);
    const base = parts[parts.length - 1].replace(/\.(md|markdown|txt)$/i, '');
    const meta = parsed.meta;
    const book = (typeof meta.notebook === 'string' && meta.notebook) || folders[0] || null;
    const section =
      (typeof meta.section === 'string' && meta.section) ||
      (folders.length > 1 ? folders.slice(1).join(' / ') : null);
    if (book) bookNames.add(book);
    const images = new Map<string, Blob>();
    const dir = parts.slice(0, -1).join('/');
    for (const src of parsed.images) {
      if (/^(https?:|data:)/i.test(src)) continue;
      const entry =
        archive.get(normalizePath(`${dir}/${src}`)) ??
        archive.get(normalizePath(src)) ??
        byBase.get(src.split('/').pop()!.toLowerCase());
      if (!entry) {
        plan.warnings.push(`«${base}»: картинка «${src}» не найдена в архиве`);
        continue;
      }
      images.set(
        src,
        new Blob([new Uint8Array(await entry.read())], { type: mimeOf(entry.name, 'image/png') }),
      );
    }
    const updated = [meta.updated, meta.updatedAt, meta.modified, meta.date].find(
      (v) => typeof v === 'string',
    );
    const updatedDate =
      typeof updated === 'string' && !isNaN(Date.parse(updated)) ? new Date(updated) : file.date;
    plan.notes.push({
      title:
        (typeof meta.title === 'string' && meta.title) || parsed.title || base || 'Без названия',
      html: parsed.html,
      tags: parsed.tags,
      book,
      section,
      pinned: meta.pinned === true,
      updatedAt: updatedDate.toISOString(),
      source: `md:${file.path}:${hash(file.text)}`,
      images,
    });
  }
  plan.books = [...bookNames];
  return plan;
}

// ---------- полная копия SelfNote ----------
interface SelfnoteExport {
  format: string;
  version: number;
  notebooks: { id: string; name: string; color: string }[];
  sections: { id: string; notebookId: string; name: string }[];
  tags: string[];
  notes: {
    id: string;
    title: string;
    notebookId: string | null;
    sectionId: string | null;
    tags: string[];
    pinned: boolean;
    updatedAt: string;
    content: PMNode;
  }[];
}
async function planSelfnote(fileName: string, entries: ZipEntry[]): Promise<ImportPlan> {
  const byName = new Map(entries.map((e) => [e.name, e]));
  const data = JSON.parse(await readZipText(byName.get('selfnote.json')!)) as SelfnoteExport;
  if (data.format !== 'selfnote-export') throw new Error('Неизвестный формат копии SelfNote');
  const plan: ImportPlan = {
    kind: 'selfnote',
    fileName,
    notes: [],
    books: [],
    skipped: [],
    warnings: [],
  };
  const books = new Map(data.notebooks.map((b) => [b.id, b]));
  const sections = new Map(data.sections.map((s) => [s.id, s]));
  for (const note of data.notes) {
    const images = new Map<string, Blob>();
    const walk = async (node: PMNode) => {
      const src = node.type === 'image' ? String(node.attrs?.src ?? '') : '';
      if (src && !images.has(src)) {
        const entry = byName.get(src);
        if (entry)
          images.set(
            src,
            new Blob([new Uint8Array(await entry.read())], { type: mimeOf(src, 'image/webp') }),
          );
        else plan.warnings.push(`«${note.title}»: нет картинки «${src}»`);
      }
      for (const child of node.content ?? []) await walk(child);
    };
    await walk(note.content);
    const book = note.notebookId ? books.get(note.notebookId) : undefined;
    plan.notes.push({
      title: note.title || 'Без названия',
      json: note.content,
      tags: note.tags ?? [],
      book: book?.name ?? null,
      bookColor: book?.color,
      section: note.sectionId ? (sections.get(note.sectionId)?.name ?? null) : null,
      pinned: note.pinned,
      updatedAt: note.updatedAt,
      source: `selfnote:${note.id}`,
      images,
    });
  }
  plan.books = data.notebooks.map((b) => b.name);
  return plan;
}

// ---------- запись в пространство ----------
const PALETTE = ['#C2410C', '#3451D1', '#2B7A3D', '#7A3DB8', '#0F766E', '#B45309'];

function walkJson(node: PMNode, visit: (node: PMNode) => void) {
  visit(node);
  for (const child of node.content ?? []) walkJson(child, visit);
}

export async function applyImport(
  workspace: Workspace,
  plan: ImportPlan,
  progress?: (done: number, total: number) => void,
): Promise<ImportReport> {
  const extensions = contentExtensions(workspace.userId);
  const schema = getSchema(extensions);
  const report: ImportReport = {
    notes: 0,
    books: 0,
    sections: 0,
    tasks: 0,
    images: 0,
    duplicates: 0,
    skipped: [...plan.skipped],
    warnings: [...plan.warnings],
  };
  const sources = workspace.importedSources();
  const books = new Map<string, string>();
  for (const b of workspace.notebooks.values()) books.set(b.name.toLowerCase(), b.id);
  const sections = new Map<string, string>();
  for (const s of workspace.sections.values())
    sections.set(`${s.notebookId}/${s.name.toLowerCase()}`, s.id);
  const bookId = (name: string, color?: string) => {
    const key = name.toLowerCase();
    let id = books.get(key);
    if (!id) {
      id = uuid();
      workspace.notebooks.set(id, {
        id,
        name,
        color: color ?? PALETTE[workspace.notebooks.size % PALETTE.length],
      });
      books.set(key, id);
      report.books++;
    }
    return id;
  };
  const sectionId = (notebookId: string, name: string) => {
    const key = `${notebookId}/${name.toLowerCase()}`;
    let id = sections.get(key);
    if (!id) {
      id = uuid();
      workspace.sections.set(id, { id, notebookId, name });
      sections.set(key, id);
      report.sections++;
    }
    return id;
  };
  const stats: NormalizeStats = { tables: 0, checkboxes: 0 };
  let done = 0;
  for (const note of plan.notes) {
    done++;
    if (sources.has(note.source)) {
      report.duplicates++;
      continue;
    }
    try {
      // картинки — в локальную очередь загрузки (уйдут на сервер, когда будет сеть)
      const localSrc = new Map<string, string>();
      for (const [src, blob] of note.images) {
        const name = src.split('/').pop() || 'image';
        const file = new File([blob], name, { type: blob.type || mimeOf(name, 'image/png') });
        try {
          localSrc.set(src, await storeImage(file, workspace.userId));
          report.images++;
        } catch (e) {
          report.warnings.push(`«${note.title}»: ${(e as Error).message}`);
        }
      }
      let json: PMNode;
      if (note.json) json = structuredClone(note.json);
      else {
        const dom = new DOMParser().parseFromString(`<body>${note.html ?? ''}</body>`, 'text/html');
        for (const img of [...dom.body.querySelectorAll('img')]) {
          const src = img.getAttribute('src') ?? '';
          const local = localSrc.get(src);
          if (local) img.setAttribute('src', local);
          else if (/^https?:/i.test(src)) {
            const a = dom.createElement('a');
            a.href = src;
            a.textContent = img.getAttribute('alt') || 'изображение';
            img.replaceWith(a);
          } else img.remove();
        }
        json = generateJSON(normalizeHtml(dom.body.innerHTML, stats), extensions) as PMNode;
      }
      walkJson(json, (node) => {
        if (node.type === 'taskItem') {
          node.attrs = { ...node.attrs, id: uuid() };
          report.tasks++;
        }
        if (node.type === 'image') {
          const src = String(node.attrs?.src ?? '');
          node.attrs = { ...node.attrs, src: localSrc.get(src) ?? src };
        }
      });
      // картинки без загруженного файла выкидываем, чтобы не было «битых» блоков
      walkJson(json, (node) => {
        if (node.content)
          node.content = node.content.filter(
            (c) => c.type !== 'image' || String(c.attrs?.src ?? '').startsWith('local-image:'),
          );
      });
      const notebookId = note.book ? bookId(note.book, note.bookColor) : null;
      const section = notebookId && note.section ? sectionId(notebookId, note.section) : null;
      for (const tag of note.tags) workspace.tags.set(tag, tag);
      workspace.addNote(
        {
          title: note.title,
          notebookId,
          sectionId: section,
          tags: note.tags,
          pinned: note.pinned ?? false,
          updatedAt: note.updatedAt,
          source: note.source,
        },
        (fragment) => {
          prosemirrorJSONToYXmlFragment(schema, json, fragment);
        },
      );
      report.notes++;
    } catch (e) {
      report.skipped.push({
        title: note.title,
        reason: `ошибка преобразования: ${(e as Error).message}`,
      });
    }
    progress?.(done, plan.notes.length);
    if (done % 10 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  if (stats.tables)
    report.warnings.push(`Таблиц превращено в текст: ${stats.tables} (в редакторе нет таблиц)`);
  void flushImages(workspace);
  return report;
}

import * as Y from 'yjs';
import { localDate } from './dates.js';
import { checkTaskAttributes } from './repeat.js';
export * from './dates.js';
export * from './repeat.js';
export * from './render.js';
export * from './search.js';
export * from './secure.js';
export interface Notebook {
  id: string;
  name: string;
  color: string;
  icon?: string;
}
export interface Section {
  id: string;
  notebookId: string;
  name: string;
}
export interface Note {
  id: string;
  title: string;
  notebookId: string | null;
  sectionId: string | null;
  tags: string[];
  pinned: boolean;
  /** Избранное — отдельный раздел в навигации. */
  favorite?: boolean;
  updatedAt: string;
  deletedAt: string | null;
  encrypted: boolean;
  /** Заголовок заметки под паролем тоже зашифрован; в списке — «Заметка под паролем». */
  hideTitle?: boolean;
  color: string | null;
  /** Откуда импортирована (например, nsx:1026_…) — защита от повторного импорта. */
  source?: string;
}
export interface Task {
  id: string;
  text: string;
  checked: boolean;
  due: string | null;
  doneAt: string | null;
  position: number;
  /** Правило повтора (подмножество RRULE), см. repeat.ts. */
  repeat?: string | null;
}
export function extractDocument(doc: Y.Doc): { plainText: string; tasks: Task[] } {
  const tasks: Task[] = [];
  function text(node: Y.XmlFragment | Y.XmlElement | Y.XmlText): string {
    if (node instanceof Y.XmlText)
      return node
        .toDelta()
        .map((part: { insert: unknown }) => (typeof part.insert === 'string' ? part.insert : ''))
        .join('');
    return node
      .toArray()
      .map((child) =>
        child instanceof Y.XmlElement || child instanceof Y.XmlText ? text(child) : '',
      )
      .join(
        node instanceof Y.XmlElement && ['paragraph', 'heading'].includes(node.nodeName)
          ? ''
          : '\n',
      );
  }
  function walk(node: Y.XmlFragment | Y.XmlElement) {
    for (const child of node.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      if (child.nodeName === 'taskItem') {
        const attrs = child.getAttributes() as Record<string, unknown>;
        if (typeof attrs.id === 'string' && attrs.id)
          tasks.push({
            id: attrs.id,
            text: text(child).trim(),
            checked: attrs.checked === true || attrs.checked === 'true',
            due: typeof attrs.due === 'string' && attrs.due ? attrs.due : null,
            doneAt: typeof attrs.doneAt === 'string' && attrs.doneAt ? attrs.doneAt : null,
            position: tasks.length,
            repeat: typeof attrs.repeat === 'string' && attrs.repeat ? attrs.repeat : null,
          });
      }
      walk(child);
    }
  }
  const content = doc.getXmlFragment('content');
  walk(content);
  return { plainText: text(content).trim(), tasks };
}
export function setTaskChecked(doc: Y.Doc, id: string, checked: boolean): boolean {
  let found = false;
  function walk(node: Y.XmlFragment | Y.XmlElement) {
    for (const child of node.toArray())
      if (child instanceof Y.XmlElement) {
        if (child.nodeName === 'taskItem' && child.getAttribute('id') === id) {
          const attrs = child.getAttributes() as Record<string, unknown>;
          const patch = checkTaskAttributes(attrs, checked, localDate());
          for (const [key, value] of Object.entries(patch))
            child.setAttribute(key, value as unknown as string);
          found = true;
        }
        walk(child);
      }
  }
  doc.transact(() => walk(doc.getXmlFragment('content')));
  return found;
}
/** Заметки из документа пространства, лежащие в корзине (поддерживает старый и новый формат). */
export function deletedNoteIds(space: Y.Doc): Set<string> {
  const result = new Set<string>();
  for (const [id, value] of space.getMap<unknown>('notes')) {
    const deletedAt =
      value instanceof Y.Map
        ? value.get('deletedAt')
        : (value as { deletedAt?: unknown })?.deletedAt;
    if (deletedAt) result.add(id);
  }
  return result;
}
/** Убирает повторы задач с одинаковым id внутри заметки (бывает при слиянии офлайн-правок). */
export function uniqueTasks(tasks: Task[]): Task[] {
  const seen = new Set<string>();
  return tasks.filter((task) => (seen.has(task.id) ? false : (seen.add(task.id), true)));
}
/**
 * Какие версии оставить: все за последние сутки, по одной (последней) за день — 30 дней,
 * дальше по одной за неделю.
 */
export function versionsToKeep(
  versions: { id: string; created_at: string }[],
  now = Date.now(),
): Set<string> {
  const keep = new Set<string>();
  const buckets = new Set<string>();
  const sorted = [...versions].sort((a, b) => b.created_at.localeCompare(a.created_at));
  for (const v of sorted) {
    const age = now - Date.parse(v.created_at);
    if (age < 86400000) {
      keep.add(v.id);
      continue;
    }
    const bucket =
      age < 30 * 86400000
        ? 'd' + v.created_at.slice(0, 10)
        : 'w' + Math.floor(Date.parse(v.created_at) / (7 * 86400000));
    if (!buckets.has(bucket)) {
      buckets.add(bucket);
      keep.add(v.id);
    }
  }
  return keep;
}

/** Возраст корзины считается от удаления, а не от последней правки. */
export function expiredNoteIds(space: Y.Doc, now = Date.now()): string[] {
  return [...space.getMap<unknown>('notes')]
    .filter(([, value]) => {
      const date = value instanceof Y.Map ? value.get('deletedAt') : (value as Note)?.deletedAt;
      return typeof date === 'string' && Date.parse(date) < now - 30 * 86400000;
    })
    .map(([id]) => id);
}
/** Клонируем содержимое: applyUpdate старого снапшота не отменяет удаления Yjs. */
export function restoreContent(target: Y.Doc, snapshot: Uint8Array) {
  const source = new Y.Doc();
  try {
    Y.applyUpdate(source, snapshot);
    const children = source
      .getXmlFragment('content')
      .toArray()
      .filter(
        (node): node is Y.XmlElement | Y.XmlText =>
          node instanceof Y.XmlElement || node instanceof Y.XmlText,
      )
      .map((node) => node.clone());
    target.transact(() => {
      const content = target.getXmlFragment('content');
      content.delete(0, content.length);
      content.insert(0, children);
    }, 'restore-version');
  } finally {
    source.destroy();
  }
}
export * from './zip.js';
/**
 * Какие резервные копии оставить: последние 7 дней (по одной в день),
 * 4 недели (по одной в неделю) и 6 месяцев (по одной в месяц). Схема «дед-отец-сын».
 */
export function backupsToKeep(backups: { name: string; created_at: string }[]): Set<string> {
  const sorted = [...backups].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const keep = new Set<string>();
  const pick = (key: (d: Date) => string, limit: number) => {
    const seen = new Set<string>();
    for (const b of sorted) {
      const k = key(new Date(b.created_at));
      if (seen.has(k)) continue;
      if (seen.size >= limit) break;
      seen.add(k);
      keep.add(b.name);
    }
  };
  pick((d) => d.toISOString().slice(0, 10), 7);
  pick((d) => {
    const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
    return monday.toISOString().slice(0, 10);
  }, 4);
  pick((d) => d.toISOString().slice(0, 7), 6);
  return keep;
}

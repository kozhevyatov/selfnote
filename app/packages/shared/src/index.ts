import * as Y from 'yjs';
export interface Notebook {
  id: string;
  name: string;
  color: string;
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
  updatedAt: string;
  deletedAt: string | null;
  encrypted: boolean;
  color: string | null;
}
export interface Task {
  id: string;
  text: string;
  checked: boolean;
  due: string | null;
  doneAt: string | null;
  position: number;
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
          child.setAttribute('checked', checked as unknown as string);
          child.setAttribute(
            'doneAt',
            (checked ? new Date().toISOString() : null) as unknown as string,
          );
          found = true;
        }
        walk(child);
      }
  }
  doc.transact(() => walk(doc.getXmlFragment('content')));
  return found;
}
export function localDate(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function dueDay(due: string): string {
  return due.length === 10 ? due : localDate(new Date(due));
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

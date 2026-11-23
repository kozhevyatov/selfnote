/**
 * Данные пользователя на устройстве: тот же формат Yjs, что у веба (см. AGENTS.md §3.1).
 * Одно WebSocket-соединение на все документы, состояние — в SQLite (LocalStore).
 */
import * as Y from 'yjs';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import {
  dueDay,
  extractDocument,
  localDate,
  setTaskChecked,
  type CollaborationList,
  type Note,
  type Notebook,
  type Section,
  type Task,
} from '@selfnote/shared';
import { api, socketUrl, token } from '../auth';
import { LocalStore } from './localStore';
import { uuid } from '../ids';

type Extracted = ReturnType<typeof extractDocument>;
type StoredNote = Y.Map<unknown> | Note;
export type Connection = 'online' | 'connecting' | 'offline';
export interface Entry {
  name: string;
  doc: Y.Doc;
  provider: HocuspocusProvider;
  ready: Promise<void>;
}
export interface TaskRow extends Task {
  noteId: string;
  noteTitle: string;
}

const EMPTY: Extracted = { plainText: '', tasks: [] };
const toNote = (value: StoredNote): Note =>
  value instanceof Y.Map ? (value.toJSON() as Note) : value;

export class Workspace {
  private readonly socket: HocuspocusProviderWebsocket;
  readonly space: Entry;
  private readonly notes = new Map<string, Entry>();
  private readonly extracted = new Map<string, Extracted>();
  private metaCache: Map<string, Note> | null = null;
  private listeners = new Set<() => void>();
  private revision = 0;
  private emitTimer: ReturnType<typeof setTimeout> | undefined;
  private queue: string[] = [];
  private pumping = false;
  private stopped = false;
  private collaborationTimer: ReturnType<typeof setInterval>;
  collaboration: CollaborationList = { notes: [], owned: [] };
  connection: Connection = 'connecting';
  /** Есть изменения, ещё не подтверждённые сервером. */
  get unsynced() {
    return [this.space, ...this.notes.values()].some((e) => e.provider.hasUnsyncedChanges);
  }

  constructor(
    readonly server: string,
    readonly userId: string,
    private readonly store: LocalStore,
  ) {
    this.socket = new HocuspocusProviderWebsocket({ url: socketUrl(server) });
    this.socket.on('status', ({ status }: { status: string }) => {
      this.connection =
        status === 'connected' ? 'online' : status === 'connecting' ? 'connecting' : 'offline';
      if (status === 'connected') void this.refreshCollaboration();
      this.emit();
    });
    this.space = this.open(`space:${userId}`);
    this.space.doc.on('update', () => {
      this.metaCache = null;
      this.schedule();
      this.emit();
    });
    this.space.ready.then(() => this.schedule());
    void store.get<CollaborationList>('collaboration').then((cached) => {
      if (cached && !this.collaboration.notes.length) {
        this.collaboration = cached;
        this.metaCache = null;
        this.schedule();
        this.emit();
      }
    });
    this.collaborationTimer = setInterval(() => void this.refreshCollaboration(), 30000);
  }

  // ===== подписка для React =====
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  getRevision = () => this.revision;
  /** Изменения приходят пачками — перерисовываем не чаще раза в кадр. */
  private emit() {
    if (this.emitTimer || this.stopped) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = undefined;
      this.revision++;
      for (const listener of this.listeners) listener();
    }, 16);
  }

  private open(name: string): Entry {
    const doc = new Y.Doc();
    const provider = new HocuspocusProvider({
      websocketProvider: this.socket,
      name,
      document: doc,
      token: () => token(),
      onSynced: () => this.emit(),
      onUnsyncedChanges: () => this.emit(),
      onAuthenticationFailed: () => this.emit(),
    });
    // Сначала локальная копия, потом сеть: заметки видны сразу, даже без связи.
    const ready = this.store
      .bind(name, doc)
      .catch(() => undefined)
      .then(() => {
        if (!this.stopped) provider.attach();
      });
    return { name, doc, provider, ready };
  }

  /** Документ заметки (открывается при первом обращении). */
  note(id: string): Entry {
    let entry = this.notes.get(id);
    if (!entry) {
      entry = this.open(`note:${id}`);
      this.notes.set(id, entry);
      entry.doc.on('update', () => {
        this.extracted.delete(id);
        this.metaCache = null;
        this.emit();
      });
      entry.ready.then(() => this.emit());
    }
    return entry;
  }

  /** Открываем документы заметок очередью (свежие первыми), чтобы показать превью и задачи. */
  private schedule() {
    this.queue = [...this.metadata.values()]
      .filter((n) => !n.encrypted && !n.deletedAt && n.kind !== 'passwords' && !this.notes.has(n.id))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((n) => n.id);
    void this.pump();
  }
  private async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length && !this.stopped) {
        const id = this.queue.shift()!;
        if (!this.notes.has(id)) await this.note(id).ready;
      }
    } finally {
      this.pumping = false;
    }
  }

  // ===== данные =====
  get metadata(): ReadonlyMap<string, Note> {
    if (!this.metaCache) {
      const map = new Map<string, Note>();
      for (const [id, value] of this.space.doc.getMap<StoredNote>('notes')) map.set(id, toNote(value));
      for (const row of this.collaboration.notes)
        if (!row.pending && !map.has(row.note.id)) map.set(row.note.id, row.note);
      for (const [id, meta] of map) {
        const fields = this.notes.get(id)?.doc.getMap('collaboration');
        const title = fields?.get('title');
        const updatedAt = fields?.get('updatedAt');
        if (typeof title === 'string')
          map.set(id, {
            ...meta,
            title,
            ...(typeof updatedAt === 'string' && Number.isFinite(Date.parse(updatedAt))
              ? { updatedAt }
              : {}),
          });
      }
      this.metaCache = map;
    }
    return this.metaCache;
  }
  /** Живые заметки (без корзины и сейфа паролей), свежие первыми. */
  visibleNotes(): Note[] {
    return [...this.metadata.values()]
      .filter((n) => !n.deletedAt && n.kind !== 'passwords')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  private sorted<T extends { id: string }>(items: T[]): T[] {
    const order = this.space.doc.getMap<number>('order');
    return items
      .map((item, index) => ({ item, index, rank: order.get(item.id) ?? Infinity }))
      .sort((a, b) => (a.rank === b.rank ? a.index - b.index : a.rank - b.rank))
      .map((e) => e.item);
  }
  notebooks(): Notebook[] {
    return this.sorted([...this.space.doc.getMap<Notebook>('notebooks').values()]);
  }
  sections(notebookId?: string): Section[] {
    const all = [...this.space.doc.getMap<Section>('sections').values()];
    return this.sorted(notebookId ? all.filter((s) => s.notebookId === notebookId) : all);
  }
  notebook(id: string | null | undefined) {
    return id ? this.space.doc.getMap<Notebook>('notebooks').get(id) : undefined;
  }
  section(id: string | null | undefined) {
    return id ? this.space.doc.getMap<Section>('sections').get(id) : undefined;
  }
  appearance(): { theme?: string; accent?: string } {
    const prefs = this.space.doc.getMap<string>('prefs');
    return { theme: prefs.get('theme'), accent: prefs.get('accent') };
  }
  isLoaded(id: string) {
    return this.notes.has(id);
  }
  isCollaborative(id: string) {
    return (
      this.collaboration.owned.includes(id) ||
      this.collaboration.notes.some((row) => row.note.id === id && !row.pending)
    );
  }
  canEdit(id: string) {
    if (this.space.doc.getMap('notes').has(id)) return true;
    return this.collaboration.notes.some((r) => r.note.id === id && !r.pending && r.role === 'editor');
  }

  /** Текст и задачи заметки; пересчёт только после её изменения. */
  extract(id: string): Extracted {
    const entry = this.notes.get(id);
    if (!entry) return EMPTY;
    let value = this.extracted.get(id);
    if (!value) {
      value = extractDocument(entry.doc);
      this.extracted.set(id, value);
    }
    return value;
  }
  /** Невыполненные задачи со сроком на сегодня и просроченные — из всех заметок. */
  todayTasks(): TaskRow[] {
    const today = localDate();
    const rows: TaskRow[] = [];
    for (const note of this.visibleNotes()) {
      if (note.encrypted) continue;
      for (const task of this.extract(note.id).tasks)
        if (!task.checked && task.due && dueDay(task.due) <= today)
          rows.push({ ...task, noteId: note.id, noteTitle: note.title });
    }
    return rows.sort((a, b) => dueDay(a.due!).localeCompare(dueDay(b.due!)));
  }
  /** Все задачи для вкладки «Задачи». */
  allTasks(): TaskRow[] {
    const rows: TaskRow[] = [];
    for (const note of this.visibleNotes()) {
      if (note.encrypted) continue;
      for (const task of this.extract(note.id).tasks)
        rows.push({ ...task, noteId: note.id, noteTitle: note.title });
    }
    return rows;
  }
  setTask(noteId: string, taskId: string, checked: boolean) {
    if (!this.canEdit(noteId)) return;
    const entry = this.note(noteId);
    if (setTaskChecked(entry.doc, taskId, checked)) this.touch(noteId);
  }
  /** Поднять заметку в списке после правки содержимого (как update(id, {}) в вебе). */
  touch(id: string) {
    this.patch(id, {}, true);
  }
  setTitle(id: string, title: string) {
    this.patch(id, { title }, true);
  }
  /** Свойства заметки: как Workspace.update в вебе (общие заметки — через карту collaboration). */
  private patch(id: string, values: Partial<Note>, touch: boolean) {
    if (!this.canEdit(id)) return;
    const now = new Date().toISOString();
    const entry = this.notes.get(id);
    const shared = entry?.doc.getMap('collaboration');
    if (shared?.has('title'))
      entry!.doc.transact(() => {
        if (values.title !== undefined) shared.set('title', values.title);
        if (touch) shared.set('updatedAt', now);
      });
    const notes = this.space.doc.getMap<StoredNote>('notes');
    const current = notes.get(id);
    if (!current) return;
    this.space.doc.transact(() => {
      let fields: Y.Map<unknown>;
      if (current instanceof Y.Map) fields = current;
      else {
        // перевод заметки старого формата в Y.Map
        fields = new Y.Map();
        for (const [key, value] of Object.entries(current)) fields.set(key, value);
        notes.set(id, fields);
      }
      for (const [key, value] of Object.entries(values))
        if (JSON.stringify(fields.get(key)) !== JSON.stringify(value)) fields.set(key, value ?? null);
      if (touch) fields.set('updatedAt', now);
    });
  }
  /** Новая пустая заметка (как createNote в вебе). */
  addNote(notebookId: string | null, sectionId: string | null): string {
    const id = uuid();
    const fields = new Y.Map<unknown>();
    for (const [key, value] of Object.entries({
      id,
      title: '',
      notebookId,
      sectionId,
      tags: [],
      pinned: false,
      updatedAt: new Date().toISOString(),
      deletedAt: null,
      encrypted: false,
      color: null,
    } satisfies Note))
      fields.set(key, value);
    this.space.doc.getMap<StoredNote>('notes').set(id, fields);
    this.note(id);
    return id;
  }
  /** Заметку создали и ничего не написали — убираем её совсем, не в корзину. */
  discardIfEmpty(id: string) {
    const meta = this.metadata.get(id);
    if (!meta || meta.title.trim() || !this.space.doc.getMap('notes').has(id)) return;
    const entry = this.notes.get(id);
    const content = entry?.doc.getXmlFragment('content');
    if (!content || content.length > 1 || content.toString().includes('<image')) return;
    if (this.extract(id).plainText.trim()) return;
    if (this.extract(id).tasks.length) return;
    this.space.doc.transact(() => {
      this.space.doc.getMap('purged').set(id, true);
      this.space.doc.getMap('notes').delete(id);
    });
  }

  /** Картинка заметки как data: URI для редактора (кэш в памяти на время работы). */
  private images = new Map<string, Promise<string>>();
  imageData(src: string): Promise<string> {
    if (!src.startsWith('/api/attachments/'))
      return Promise.reject(new Error('Картинка ещё не синхронизирована'));
    let pending = this.images.get(src);
    if (!pending) {
      pending = (async () => {
        const response = await fetch(this.server + src, {
          headers: { Authorization: `Bearer ${await token()}`, 'X-SelfNote-Client': 'app' },
        });
        if (!response.ok) throw new Error('Изображение недоступно');
        const blob = await response.blob();
        return await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error('Не удалось прочитать изображение'));
          reader.readAsDataURL(blob);
        });
      })();
      pending.catch(() => this.images.delete(src));
      this.images.set(src, pending);
    }
    return pending;
  }

  async refreshCollaboration() {
    if (this.stopped) return;
    try {
      const next = await api<CollaborationList>('/api/collaboration');
      if (this.stopped) return;
      this.collaboration = next;
      this.metaCache = null;
      void this.store.set('collaboration', next);
      this.schedule();
      this.emit();
    } catch {
      /* без сети остаётся последняя сохранённая копия */
    }
  }

  /** Приложение возвращается из фона — переподключаемся сразу, не дожидаясь таймера. */
  wake() {
    if (this.stopped) return;
    void this.socket.connect();
    void this.refreshCollaboration();
  }
  /** Уход в фон: записываем всё на диск. */
  async persist() {
    await this.store.flush().catch(() => undefined);
  }

  async destroy() {
    this.stopped = true;
    clearInterval(this.collaborationTimer);
    clearTimeout(this.emitTimer);
    for (const entry of [this.space, ...this.notes.values()]) entry.provider.destroy();
    this.socket.destroy();
    await this.store.close();
    this.listeners.clear();
  }
}

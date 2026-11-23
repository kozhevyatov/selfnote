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
import { Images } from './images';
import { SecureNotes, secureTitle } from './secure';
import { PasswordVault } from './vault';
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
  /** Ручной порядок во вкладке «Задачи» (карта taskOrder, как в вебе). */
  order?: number;
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
  private readonly images: Images;
  readonly secure: SecureNotes;
  readonly vault: PasswordVault;
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
      if (status === 'connected') {
        void this.refreshCollaboration();
        void this.secure.sync();
        setTimeout(() => void this.uploadImages(), 3000);
      }
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
    this.images = new Images(server, store, userId);
    const self = this; // eslint-disable-line @typescript-eslint/no-this-alias
    this.secure = new SecureNotes(
      {
        get metadata() {
          return self.metadata;
        },
        online: () => this.connection === 'online',
        addEncrypted: (id, meta) => this.addEncrypted(id, meta),
        emit: () => this.emit(),
      },
      store,
    );
    this.vault = new PasswordVault(
      {
        get metadata() {
          return self.metadata;
        },
        online: () => this.connection === 'online',
        emit: () => this.emit(),
      },
      this.secure,
      store,
    );
    this.collaborationTimer = setInterval(() => {
      void this.refreshCollaboration();
      void this.uploadImages();
    }, 30000);
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
    this.scheduleCleanup();
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
  /** Живые заметки (без корзины), свежие первыми. Записи паролей — тоже заметки. */
  visibleNotes(): Note[] {
    return [...this.metadata.values()]
      .filter((n) => !n.deletedAt)
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
    const order = this.space.doc.getMap<number>('taskOrder');
    const rows: TaskRow[] = [];
    for (const note of this.visibleNotes()) {
      if (note.encrypted) continue;
      for (const task of this.extract(note.id).tasks)
        rows.push({
          ...task,
          noteId: note.id,
          noteTitle: note.title,
          order: order.get(`${note.id}:${task.id}`),
        });
    }
    return rows;
  }
  setTaskOrder(keys: string[]) {
    const order = this.space.doc.getMap<number>('taskOrder');
    this.space.doc.transact(() => keys.forEach((key, index) => order.set(key, index)));
  }
  /** Метки пространства (имена). */
  tags(): string[] {
    return [...this.space.doc.getMap<string>('tags').keys()].sort((a, b) => a.localeCompare(b, 'ru'));
  }
  addTag(name: string) {
    const tag = name.trim().replace(/^#/, '');
    if (tag) this.space.doc.getMap<string>('tags').set(tag, tag);
    return tag;
  }
  setAppearance(theme: 'system' | 'light' | 'dark', accent: string) {
    const prefs = this.space.doc.getMap<string>('prefs');
    this.space.doc.transact(() => {
      prefs.set('theme', theme);
      prefs.set('accent', accent);
    });
  }
  /** Корзина: свои заметки с deletedAt, свежие первыми. */
  trash(): Note[] {
    return [...this.metadata.values()]
      .filter((n) => n.deletedAt && this.isOwner(n.id))
      .sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)));
  }
  /** Удалить навсегда (как deleteForever в вебе): надгробие в purged, чтобы другие устройства не вернули. */
  deleteForever(ids: string[]) {
    this.space.doc.transact(() => {
      for (const id of ids)
        if (this.metadata.get(id)?.deletedAt) {
          this.space.doc.getMap('purged').set(id, true);
          this.space.doc.getMap('notes').delete(id);
        }
    });
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
  isOwner(id: string) {
    return this.space.doc.getMap('notes').has(id);
  }
  /** Свойства без подъёма в списке: закрепление, избранное, перенос, корзина. */
  update(id: string, values: Partial<Note>) {
    if (this.isOwner(id)) this.patch(id, values, false);
  }
  setTitle(id: string, title: string) {
    const meta = this.metadata.get(id);
    if (meta?.encrypted && meta.hideTitle) {
      this.secure.doc(id)?.getMap('secure').set('title', title);
      this.patch(id, {}, true);
      return;
    }
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
  /** Метаданные заметки под паролем (как addEncryptedNote в вебе). */
  private addEncrypted(
    id: string,
    meta: Pick<Note, 'title' | 'notebookId' | 'sectionId' | 'kind'> & { hideTitle: boolean },
  ) {
    const fields = new Y.Map<unknown>();
    for (const [key, value] of Object.entries({
      id,
      title: meta.title,
      notebookId: meta.notebookId,
      sectionId: meta.sectionId,
      tags: [],
      pinned: false,
      updatedAt: new Date().toISOString(),
      deletedAt: null,
      encrypted: true,
      hideTitle: meta.hideTitle,
      color: null,
    } satisfies Note))
      fields.set(key, value);
    if (meta.kind) fields.set('kind', meta.kind);
    this.space.doc.getMap<StoredNote>('notes').set(id, fields);
  }
  /** Название для показа и правки: у заметок со скрытым заголовком оно внутри шифра. */
  noteTitle(id: string): string {
    const meta = this.metadata.get(id);
    if (meta?.encrypted && meta.hideTitle) {
      const doc = this.secure.doc(id);
      return doc ? secureTitle(doc) : '';
    }
    return meta?.title ?? '';
  }
  /** Документ содержимого: обычный или расшифрованный (если заметка под паролем открыта). */
  contentDoc(id: string): Y.Doc | undefined {
    return this.metadata.get(id)?.encrypted ? this.secure.doc(id) : this.notes.get(id)?.doc;
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

  /**
   * Раз за запуск чистим кэш картинок — когда открыты документы всех заметок
   * (включая корзину) и пространство синхронизировано с сервером.
   */
  private cleaned = false;
  private cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  private scheduleCleanup() {
    if (this.cleaned || this.stopped) return;
    clearTimeout(this.cleanupTimer);
    this.cleanupTimer = setTimeout(() => {
      if (this.cleaned || this.stopped || this.queue.length || this.pumping) return;
      if (!this.space.provider.isSynced) return this.scheduleCleanup();
      const ids = [...this.metadata.values()]
        .filter((n) => !n.encrypted && n.kind !== 'passwords')
        .map((n) => n.id);
      if (ids.some((id) => !this.notes.has(id))) {
        // корзина в очередь не попадает — открываем и её, иначе её картинки сочтём лишними
        for (const id of ids) this.note(id);
        return this.scheduleCleanup();
      }
      this.cleaned = true;
      const entries = [...this.notes.values()];
      // документы должны быть загружены с диска, иначе пустая заметка «не ссылается» на картинки
      void Promise.all(entries.map((e) => e.ready))
        .then(() => (this.stopped ? undefined : this.images.cleanup(entries.map((e) => e.doc))))
        .catch(() => undefined);
    }, 15000);
  }

  /** Картинка заметки как data: URI для редактора (с диска или с сервера). */
  imageData(src: string): Promise<string> {
    return this.images.data(src);
  }
  /** Картинка с камеры или из галереи: сохраняется на телефоне, на сервер уходит при связи. */
  async addImage(uri: string, mime?: string): Promise<string> {
    const src = await this.images.add(uri, mime);
    setTimeout(() => void this.uploadImages(), 1500);
    return src;
  }
  uploadImages() {
    if (this.stopped || this.connection !== 'online') return Promise.resolve();
    return this.images.upload(
      [
        ...[...this.notes].map(([id, entry]) => [id, entry.doc] as [string, Y.Doc]),
        // картинки заметок под паролем грузятся без noteId (как в вебе)
        ...this.secure.docs().map(([, doc]) => ['', doc] as [string, Y.Doc]),
      ],
      (id) => {
        if (!id) return true;
        const entry = this.notes.get(id);
        return !!entry && entry.provider.isSynced && this.canEdit(id);
      },
    );
  }

  /** Настройки этого устройства (не синхронизируются). */
  local<T>(key: string) {
    return this.store.get<T>(`local:${key}`);
  }
  async setLocal(key: string, value: unknown) {
    await this.store.set(`local:${key}`, value);
    for (const listener of this.localListeners.get(key) ?? []) listener();
  }
  private localListeners = new Map<string, Set<() => void>>();
  onLocalChange(key: string, listener: () => void) {
    let set = this.localListeners.get(key);
    if (!set) this.localListeners.set(key, (set = new Set()));
    set.add(listener);
    return () => void set.delete(listener);
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
  /** Приложение ушло в фон: заметки под паролем закрываются (сохранив правки). */
  lockSecure() {
    this.vault.lock();
    this.secure.lockAll();
  }

  async destroy() {
    this.stopped = true;
    clearInterval(this.collaborationTimer);
    clearTimeout(this.cleanupTimer);
    clearTimeout(this.emitTimer);
    this.vault.destroy();
    this.secure.destroy();
    for (const entry of [this.space, ...this.notes.values()]) entry.provider.destroy();
    this.socket.destroy();
    await this.store.close();
    this.listeners.clear();
  }
}

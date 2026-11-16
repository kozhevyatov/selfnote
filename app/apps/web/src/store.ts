import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { create } from 'zustand';
import {
  extractDocument,
  expiredNoteIds,
  type Note,
  type Notebook,
  type Section,
} from '@selfnote/shared';
import { api, refresh, token } from './api';
import { uuid } from './ids';
import { SecureNotes, secureTitle } from './secure';
import type { Theme } from './theme';
export const useUI = create<{
  selected: string | null;
  filter: string;
  query: string;
  mobile: 'nav' | 'list' | 'editor';
  message: string;
  select: (id: string | null) => void;
  setFilter: (filter: string) => void;
  toast: (message: string) => void;
}>((set) => ({
  selected: null,
  filter: 'all',
  query: '',
  mobile: 'list',
  message: '',
  select: (selected) => set({ selected, mobile: selected ? 'editor' : 'list' }),
  setFilter: (filter) => set({ filter, selected: null, mobile: 'list', query: '' }),
  toast: (message) => set({ message }),
}));
export type Entry = {
  doc: Y.Doc;
  local: IndexeddbPersistence;
  provider: HocuspocusProvider;
  ready: Promise<void>;
};
type Extracted = ReturnType<typeof extractDocument>;
/** Свойства заметки: новый формат — Y.Map (правки по полям не затирают друг друга), старый — целый объект. */
type StoredNote = Y.Map<unknown> | Note;
function toNote(value: StoredNote): Note {
  return value instanceof Y.Map ? (value.toJSON() as Note) : value;
}
export class Workspace {
  /** Одно WebSocket-соединение на все документы (Hocuspocus мультиплексирует их). */
  private readonly socket: HocuspocusProviderWebsocket;
  private readonly extracted = new Map<string, Extracted>();
  private notesCache: Map<string, Note> | null = null;
  readonly space: Entry;
  readonly notes = new Map<string, Entry>();
  private callbacks = new Set<() => void>();
  private revision = 0;
  private timer: ReturnType<typeof setInterval>;
  private stopped = false;
  /** Документы, к которым сервер не пустил (удалены, под паролем и т. п.). */
  private failed = new Set<string>();
  readonly secure: SecureNotes;
  constructor(readonly userId: string) {
    this.secure = new SecureNotes(this);
    this.socket = new HocuspocusProviderWebsocket({
      url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/collab`,
    });
    this.space = this.create(`space:${userId}`);
    this.space.doc.on('update', () => {
      this.notesCache = null;
      this.loadNotes();
      this.emit();
    });
    this.space.ready.then(() => {
      this.cleanTrash();
      this.loadNotes();
      void this.secure.sync();
    });
    this.timer = setInterval(() => {
      this.cleanTrash();
      void this.saveVersions();
      void this.secure.sync();
    }, 300000);
    window.addEventListener('online', this.reconnect);
    window.addEventListener('pagehide', this.onHide);
  }
  private onHide = () => {
    for (const id of this.notes.keys()) this.markVersion(id);
  };
  private reconnect = () => {
    void refresh()
      .then(() => {
        if (this.stopped) return;
        void this.socket.connect();
        void this.flushVersions();
        void this.secure.sync();
      })
      .catch(() => this.emit());
  };
  private create(name: string): Entry {
    const doc = new Y.Doc();
    const local = new IndexeddbPersistence(`${this.userId}:${name}`, doc);
    const provider = new HocuspocusProvider({
      websocketProvider: this.socket,
      name,
      document: doc,
      token: async () => {
        await refresh();
        return token();
      },
      onStatus: () => this.emit(),
      onSynced: () => {
        this.failed.delete(name);
        if (name.startsWith('space:')) {
          this.cleanTrash();
          void this.secure.sync();
        }
        this.emit();
        void this.flushVersions();
      },
      onUnsyncedChanges: () => this.emit(),
      onAuthenticationFailed: () => {
        this.failed.add(name);
        this.emit();
      },
    });
    provider.attach();
    doc.on('update', () => this.emit());
    return { doc, local, provider, ready: local.whenSynced.then(() => undefined) };
  }
  get notebooks() {
    return this.space.doc.getMap<Notebook>('notebooks');
  }
  get sections() {
    return this.space.doc.getMap<Section>('sections');
  }
  private get noteMap() {
    return this.space.doc.getMap<StoredNote>('notes');
  }
  /** Только чтение. Менять свойства — через update(). */
  get metadata() {
    if (!this.notesCache) {
      this.notesCache = new Map();
      for (const [id, value] of this.noteMap) this.notesCache.set(id, toNote(value));
    }
    return this.notesCache as ReadonlyMap<string, Note>;
  }
  get tags() {
    return this.space.doc.getMap<string>('tags');
  }
  cleanTrash() {
    this.space.doc.transact(() => {
      for (const id of expiredNoteIds(this.space.doc))
        this.space.doc.getMap('purged').set(id, true);
      for (const id of this.space.doc.getMap('purged').keys()) this.noteMap.delete(id);
    });
  }
  deleteForever(ids: string[]) {
    this.space.doc.transact(() => {
      for (const id of ids)
        if (this.metadata.get(id)?.deletedAt) {
          this.space.doc.getMap('purged').set(id, true);
          this.noteMap.delete(id);
        }
    });
  }
  private loadNotes() {
    for (const id of [...this.notes.keys()])
      if (!this.noteMap.has(id)) {
        this.dropPlain(id);
        if (useUI.getState().selected === id) useUI.getState().select(null);
      } else if (this.metadata.get(id)?.encrypted) this.dropPlain(id);
    for (const [id, note] of this.metadata) {
      if (!note.encrypted) this.note(id);
    }
    const secureIds = new Set(
      [...this.metadata.values()].filter((n) => n.encrypted).map((n) => n.id),
    );
    if ([...secureIds].join() === [...this.secureIds].join()) return;
    for (const id of this.secureIds) if (!secureIds.has(id)) this.secure.lock(id);
    this.secureIds = secureIds;
    void this.secure.prune(secureIds).catch(() => undefined);
  }
  private secureIds = new Set<string>();
  /** Убрать открытую копию заметки с устройства (удалена или закрыта паролем). */
  dropPlain(id: string) {
    const entry = this.notes.get(id);
    if (!entry) return;
    entry.provider.destroy();
    void entry.local.clearData();
    entry.doc.destroy();
    this.notes.delete(id);
    this.extracted.delete(id);
    this.failed.delete(`note:${id}`);
    localStorage.removeItem(`version:${this.userId}:${id}`);
  }
  /** Дождаться, пока заметка получит всё с сервера и отправит свои правки. */
  async whenSynced(id: string, timeout = 15000) {
    const entry = this.note(id);
    await entry.ready;
    const deadline = Date.now() + timeout;
    while (!entry.provider.isSynced || entry.provider.hasUnsyncedChanges) {
      if (Date.now() > deadline) throw new Error('Дождитесь синхронизации заметки с сервером');
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  /** Документ заметки: обычный или расшифрованный (null — заметка под паролем закрыта). */
  noteDoc(id: string): Y.Doc | null {
    if (this.metadata.get(id)?.encrypted) return this.secure.doc(id) ?? null;
    return this.note(id).doc;
  }
  forgetExtracted(id: string) {
    this.extracted.delete(id);
  }
  /** Название для списка: у заметки со скрытым заголовком — из зашифрованного документа. */
  title(note: Note) {
    if (note.encrypted && note.hideTitle) {
      const doc = this.secure.doc(note.id);
      return doc ? secureTitle(doc) || 'Без названия' : 'Заметка под паролем';
    }
    return note.title || 'Без названия';
  }
  toast(message: string) {
    useUI.getState().toast(message);
  }
  note(id: string) {
    let entry = this.notes.get(id);
    if (!entry) {
      entry = this.create(`note:${id}`);
      this.notes.set(id, entry);
      entry.doc.on('update', (_update: Uint8Array, origin: unknown) => {
        this.extracted.delete(id);
        if (origin !== entry!.local) this.markVersion(id);
      });
      entry.ready.then(() => this.emit());
    }
    return entry;
  }
  /** Текст и задачи заметки; пересчитываются только после изменения этой заметки. */
  extract(id: string): Extracted {
    let value = this.extracted.get(id);
    if (!value) {
      const doc = this.noteDoc(id);
      if (!doc) return { plainText: '', tasks: [] };
      value = extractDocument(doc);
      this.extracted.set(id, value);
    }
    return value;
  }
  /**
   * Изменить свойства заметки. Дата правки обновляется только при изменении содержимого
   * (пустой patch) или названия — перенос, закрепление, метки не поднимают заметку в списке.
   */
  update(id: string, patch: Partial<Note>, touch = !Object.keys(patch).length || 'title' in patch) {
    const current = this.noteMap.get(id);
    if (!current) return;
    this.space.doc.transact(() => {
      let fields: Y.Map<unknown>;
      if (current instanceof Y.Map) fields = current;
      else {
        // перевод заметки старого формата в Y.Map
        fields = new Y.Map();
        for (const [key, value] of Object.entries(current)) fields.set(key, value);
        this.noteMap.set(id, fields);
      }
      for (const [key, value] of Object.entries(patch)) {
        const old = fields.get(key);
        if (JSON.stringify(old) !== JSON.stringify(value)) fields.set(key, value ?? null);
      }
      if (touch) fields.set('updatedAt', new Date().toISOString());
    });
  }
  /** Метаданные новой заметки под паролем (содержимое уже лежит в SecureNotes). */
  addEncryptedNote(
    id: string,
    meta: Pick<Note, 'title' | 'notebookId' | 'sectionId'> & { hideTitle: boolean },
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
    this.noteMap.set(id, fields);
  }
  /**
   * Создать заметку программно (импорт): не выбирает её в интерфейсе и не трогает фильтр.
   * fill заполняет содержимое до появления заметки в списке.
   */
  addNote(
    meta: Partial<Note> & { title: string; source?: string },
    fill?: (content: Y.XmlFragment) => void,
  ) {
    const id = uuid();
    const entry = this.note(id);
    if (fill) entry.doc.transact(() => fill(entry.doc.getXmlFragment('content')));
    const fields = new Y.Map<unknown>();
    for (const [key, value] of Object.entries({
      id,
      title: meta.title,
      notebookId: meta.notebookId ?? null,
      sectionId: meta.sectionId ?? null,
      tags: meta.tags ?? [],
      pinned: meta.pinned ?? false,
      updatedAt: meta.updatedAt ?? new Date().toISOString(),
      deletedAt: null,
      encrypted: false,
      color: meta.color ?? null,
    } satisfies Note))
      fields.set(key, value);
    if (meta.source) fields.set('source', meta.source);
    this.noteMap.set(id, fields);
    return id;
  }
  /** Источники уже импортированных заметок — чтобы повторный импорт не создавал дубли. */
  importedSources(): Set<string> {
    const result = new Set<string>();
    for (const value of this.noteMap.values()) {
      const source = value instanceof Y.Map ? value.get('source') : undefined;
      if (typeof source === 'string') result.add(source);
    }
    return result;
  }
  createNote(taskList = false) {
    const id = uuid();
    const filter = useUI.getState().filter;
    const section = this.sections.get(filter);
    const fields = new Y.Map<unknown>();
    for (const [key, value] of Object.entries({
      id,
      title: taskList ? 'Список задач' : '',
      notebookId: section?.notebookId || (this.notebooks.has(filter) ? filter : null),
      sectionId: section?.id || null,
      tags: filter.startsWith('tag:') ? [filter.slice(4)] : [],
      pinned: false,
      updatedAt: new Date().toISOString(),
      deletedAt: null,
      encrypted: false,
      color: null,
    } satisfies Note))
      fields.set(key, value);
    this.noteMap.set(id, fields);
    const entry = this.note(id);
    if (taskList) {
      const list = new Y.XmlElement('taskList'),
        item = new Y.XmlElement('taskItem'),
        p = new Y.XmlElement('paragraph');
      item.setAttribute('id', uuid());
      item.setAttribute('checked', false as unknown as string);
      item.insert(0, [p]);
      list.insert(0, [item]);
      entry.doc.getXmlFragment('content').insert(0, [list]);
    }
    useUI.getState().select(id);
    return id;
  }
  get status() {
    if (!navigator.onLine) return 'Офлайн · сохранено здесь';
    if (this.socket.status !== 'connected') return 'Подключение…';
    const entries = [this.space, ...this.notes.values()].filter(
      (e) => !this.failed.has(e.provider.configuration.name),
    );
    if (
      entries.some((e) => !e.provider.isSynced || e.provider.hasUnsyncedChanges) ||
      this.secure.pending
    )
      return 'Синхронизация…';
    if (this.failed.size) return 'Не всё синхронизировано';
    return 'Синхронизировано';
  }
  getTasks() {
    const order = this.space.doc.getMap<number>('taskOrder');
    return [...this.metadata.values()]
      .filter((n) => !n.deletedAt)
      .flatMap((note) =>
        this.extract(note.id).tasks.map((task) => ({
          ...task,
          noteId: note.id,
          noteTitle: this.title(note),
          order: order.get(`${note.id}:${task.id}`),
        })),
      );
  }
  /** Ручной порядок задач во вкладке «Задачи» (группа «Без срока»). */
  setTaskOrder(keys: string[]) {
    const order = this.space.doc.getMap<number>('taskOrder');
    this.space.doc.transact(() => keys.forEach((key, index) => order.set(key, index)));
  }
  /** Предпочтения, общие для всех устройств. */
  get appearance(): { theme?: Theme; accent?: string } {
    const prefs = this.space.doc.getMap<string>('prefs');
    return { theme: prefs.get('theme') as Theme | undefined, accent: prefs.get('accent') };
  }
  setAppearance(theme: Theme, accent: string) {
    const prefs = this.space.doc.getMap<string>('prefs');
    this.space.doc.transact(() => {
      prefs.set('theme', theme);
      prefs.set('accent', accent);
    });
  }
  /** Быстрая задача — в заметку «Входящие» (создаётся сама). */
  async quickTask(text: string, due: string | null) {
    const prefs = this.space.doc.getMap<string>('prefs');
    let id = prefs.get('inbox');
    const meta = id ? this.metadata.get(id) : undefined;
    if (!id || !meta || meta.deletedAt || meta.encrypted) {
      id = this.addNote({ title: 'Входящие' });
      prefs.set('inbox', id);
    }
    const entry = this.note(id);
    await entry.ready;
    const content = entry.doc.getXmlFragment('content');
    entry.doc.transact(() => {
      let list = content
        .toArray()
        .find((n): n is Y.XmlElement => n instanceof Y.XmlElement && n.nodeName === 'taskList');
      if (!list) {
        list = new Y.XmlElement('taskList');
        content.push([list]);
      }
      const item = new Y.XmlElement('taskItem');
      item.setAttribute('id', uuid());
      item.setAttribute('checked', false as unknown as string);
      if (due) item.setAttribute('due', due);
      const paragraph = new Y.XmlElement('paragraph');
      const value = new Y.XmlText();
      value.insert(0, text);
      paragraph.insert(0, [value]);
      item.insert(0, [paragraph]);
      list.push([item]);
    });
    this.update(id, {});
    return id;
  }
  subscribe = (callback: () => void) => {
    this.callbacks.add(callback);
    return () => {
      this.callbacks.delete(callback);
    };
  };
  snapshot = () => this.revision;
  emit = () => {
    this.revision++;
    for (const callback of this.callbacks) callback();
  };
  markVersion(id: string) {
    if (!this.metadata.has(id) || this.metadata.get(id)?.encrypted) return;
    localStorage.setItem(`version:${this.userId}:${id}`, '1');
  }
  async saveVersion(id: string) {
    this.markVersion(id);
    await this.flushVersions();
  }
  private async saveVersions() {
    for (const id of this.notes.keys()) {
      const note = this.metadata.get(id);
      if (note && Date.now() - Date.parse(note.updatedAt) < 310000) this.markVersion(id);
    }
    await this.flushVersions();
  }
  private flushing = false;
  async flushVersions() {
    if (this.flushing || !navigator.onLine || this.stopped) return;
    this.flushing = true;
    try {
      for (const [id, entry] of this.notes) {
        const key = `version:${this.userId}:${id}`;
        if (
          !localStorage.getItem(key) ||
          !entry.provider.isSynced ||
          entry.provider.hasUnsyncedChanges
        )
          continue;
        const bytes = Y.encodeStateAsUpdate(entry.doc);
        let binary = '';
        for (const byte of bytes) binary += String.fromCharCode(byte);
        localStorage.removeItem(key);
        try {
          await api(`/api/notes/${id}/versions`, {
            method: 'POST',
            body: JSON.stringify({ state: btoa(binary) }),
          });
        } catch {
          localStorage.setItem(key, '1');
        }
      }
    } finally {
      this.flushing = false;
    }
  }
  destroy() {
    this.stopped = true;
    this.secure.destroy();
    clearInterval(this.timer);
    window.removeEventListener('online', this.reconnect);
    window.removeEventListener('pagehide', this.onHide);
    for (const entry of [this.space, ...this.notes.values()]) {
      entry.provider.destroy();
      void entry.local.destroy();
      entry.doc.destroy();
    }
    this.socket.destroy();
    this.callbacks.clear();
  }
}

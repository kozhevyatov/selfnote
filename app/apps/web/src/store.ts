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
  constructor(readonly userId: string) {
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
    });
    this.timer = setInterval(() => {
      this.cleanTrash();
      void this.saveVersions();
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
        if (name.startsWith('space:')) this.cleanTrash();
        this.emit();
        void this.flushVersions();
      },
      onUnsyncedChanges: () => this.emit(),
      onAuthenticationFailed: () => this.emit(),
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
    for (const [id, entry] of this.notes)
      if (!this.noteMap.has(id)) {
        entry.provider.destroy();
        void entry.local.clearData();
        entry.doc.destroy();
        this.notes.delete(id);
        this.extracted.delete(id);
        localStorage.removeItem(`version:${this.userId}:${id}`);
        if (useUI.getState().selected === id) useUI.getState().select(null);
      }
    for (const id of this.noteMap.keys()) this.note(id);
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
      value = extractDocument(this.note(id).doc);
      this.extracted.set(id, value);
    }
    return value;
  }
  update(id: string, patch: Partial<Note>) {
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
      fields.set('updatedAt', new Date().toISOString());
    });
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
    const entries = [this.space, ...this.notes.values()];
    if (!navigator.onLine) return 'Офлайн · сохранено здесь';
    if (this.socket.status !== 'connected' || entries.some((e) => !e.provider.isSynced))
      return 'Подключение…';
    if (entries.some((e) => e.provider.hasUnsyncedChanges)) return 'Синхронизация…';
    return 'Синхронизировано';
  }
  getTasks() {
    return [...this.metadata.values()]
      .filter((n) => !n.deletedAt)
      .flatMap((note) =>
        this.extract(note.id).tasks.map((task) => ({
          ...task,
          noteId: note.id,
          noteTitle: note.title || 'Без названия',
        })),
      );
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
    if (!this.metadata.has(id)) return;
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

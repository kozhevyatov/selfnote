/**
 * Заметки под паролем. Расшифрованный Y.Doc живёт только в памяти, на устройстве и на
 * сервере хранится конверт AES-GCM (shared/secure.ts). Синхронизация — REST с номером
 * версии: при конфликте клиент расшифровывает серверную копию и сливает её через Yjs;
 * если расшифровать не удалось (пароль сменили на другом устройстве) — сохраняет свои
 * правки отдельной заметкой «(конфликт)».
 */
import * as Y from 'yjs';
import {
  deriveKey,
  newKdf,
  parseEnvelope,
  seal,
  unseal,
  WrongPasswordError,
  type Kdf,
} from '@selfnote/shared';
import { api } from './api';
import { uuid } from './ids';
import type { Workspace } from './store';

interface LocalRecord {
  key: string;
  version: number;
  payload: string;
  dirty: boolean;
}
interface Unlocked {
  key: Uint8Array;
  kdf: Kdf;
  doc: Y.Doc;
}
const REMOTE = 'secure-remote';
function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('selfnote-secure', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('notes', { keyPath: 'key' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
) {
  const db = await database();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction('notes', mode);
      const request = fn(tx.objectStore('notes'));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
/** Идентификаторы вложений документа — серверу, чтобы ночная очистка их не удалила. */
export function attachmentIds(doc: Y.Doc): string[] {
  const ids = new Set<string>();
  const walk = (node: Y.XmlFragment | Y.XmlElement) => {
    for (const child of node.toArray())
      if (child instanceof Y.XmlElement) {
        const src = child.getAttribute('src');
        if (child.nodeName === 'image' && src?.startsWith('/api/attachments/'))
          ids.add(src.split('/')[3]);
        walk(child);
      }
  };
  walk(doc.getXmlFragment('content'));
  return [...ids];
}
export function secureTitle(doc: Y.Doc): string {
  return String(doc.getMap('secure').get('title') ?? '');
}

export class SecureNotes {
  private open = new Map<string, Unlocked>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private pushing = new Set<string>();
  private pendingCount = 0;
  constructor(private readonly workspace: Workspace) {}

  private recordKey(id: string) {
    return `${this.workspace.userId}:${id}`;
  }
  private async record(id: string) {
    return withStore<LocalRecord | undefined>('readonly', (s) => s.get(this.recordKey(id)));
  }
  private async store(id: string, value: Omit<LocalRecord, 'key'>) {
    await withStore('readwrite', (s) => s.put({ ...value, key: this.recordKey(id) }));
  }
  private async forget(id: string) {
    await withStore('readwrite', (s) => s.delete(this.recordKey(id)));
  }
  get pending() {
    return this.pendingCount > 0 || this.timers.size > 0;
  }
  /** Открытые (расшифрованные) документы — для загрузки картинок. */
  docs(): Y.Doc[] {
    return [...this.open.values()].map((e) => e.doc);
  }
  isUnlocked(id: string) {
    return this.open.has(id);
  }
  doc(id: string): Y.Doc | undefined {
    return this.open.get(id)?.doc;
  }
  key(id: string): Uint8Array | undefined {
    return this.open.get(id)?.key;
  }
  /** Расшифровать заметку (с устройства, а если её здесь нет — с сервера). */
  async unlock(id: string, password: string) {
    let record = await this.record(id);
    if (!record) record = await this.download(id);
    if (!record) throw new Error('Заметка ещё не загружена. Подключитесь к сети.');
    const envelope = parseEnvelope(record.payload);
    const key = await deriveKey(password, envelope.kdf);
    const state = await unseal(key, envelope);
    this.attach(id, key, envelope.kdf, state);
    if (record.dirty) void this.push(id);
  }
  private attach(id: string, key: Uint8Array, kdf: Kdf, state: Uint8Array) {
    this.open.get(id)?.doc.destroy();
    const doc = new Y.Doc();
    Y.applyUpdate(doc, state, REMOTE);
    doc.on('update', (_update: Uint8Array, origin: unknown) => {
      this.workspace.forgetExtracted(id);
      if (origin !== REMOTE) this.schedule(id);
      this.workspace.emit();
    });
    this.open.set(id, { key, kdf, doc });
    this.workspace.forgetExtracted(id);
    this.workspace.emit();
  }
  lock(id: string) {
    const entry = this.open.get(id);
    if (!entry) return;
    if (this.timers.has(id)) void this.save(id);
    entry.doc.destroy();
    this.open.delete(id);
    this.workspace.forgetExtracted(id);
    this.workspace.emit();
  }
  lockAll() {
    for (const id of [...this.open.keys()]) this.lock(id);
  }
  private schedule(id: string) {
    clearTimeout(this.timers.get(id));
    this.timers.set(
      id,
      setTimeout(() => void this.save(id), 800),
    );
  }
  /** Зашифровать текущее состояние, сохранить на устройстве и отправить. */
  async save(id: string) {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    const entry = this.open.get(id);
    if (!entry) return;
    const payload = JSON.stringify(
      await seal(entry.key, entry.kdf, Y.encodeStateAsUpdate(entry.doc)),
    );
    const record = await this.record(id);
    await this.store(id, { version: record?.version ?? 0, payload, dirty: true });
    await this.push(id);
  }
  async push(id: string) {
    if (!navigator.onLine || this.pushing.has(id)) return;
    this.pushing.add(id);
    this.pendingCount++;
    this.workspace.emit();
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const record = await this.record(id);
        if (!record?.dirty) return;
        const entry = this.open.get(id);
        try {
          const result = await api<{ version: number }>(`/api/encrypted/${id}`, {
            method: 'PUT',
            body: JSON.stringify({
              version: record.version,
              payload: record.payload,
              attachments: entry ? attachmentIds(entry.doc) : [],
            }),
          });
          const latest = await this.record(id);
          // за время отправки могли появиться новые правки — они уйдут следующей попыткой
          await this.store(id, {
            version: result.version,
            payload: latest?.payload ?? record.payload,
            dirty: Boolean(latest && latest.payload !== record.payload),
          });
          if (latest && latest.payload !== record.payload) continue;
          return;
        } catch (error) {
          const e = error as Error & { status?: number; data?: Conflict };
          if (e.status !== 409 || !e.data) throw error;
          await this.resolveConflict(id, e.data);
        }
      }
    } catch (error) {
      console.warn('Заметка под паролем будет отправлена позже', error);
    } finally {
      this.pushing.delete(id);
      this.pendingCount--;
      this.workspace.emit();
    }
  }
  private async resolveConflict(id: string, conflict: Conflict) {
    const entry = this.open.get(id);
    if (!conflict.payload) {
      // пароль сняли на другом устройстве — свои правки сохраняем копией
      if (entry) await this.conflictCopy(id, entry);
      await this.forget(id);
      this.lock(id);
      return;
    }
    if (!entry) {
      // заблокирована — сливать нечем; дождёмся, пока пользователь откроет заметку
      throw new Error('Нужно открыть заметку, чтобы объединить правки');
    }
    try {
      const server = parseEnvelope(conflict.payload);
      const state = await unseal(entry.key, server);
      Y.applyUpdate(entry.doc, state, REMOTE);
      const payload = JSON.stringify(
        await seal(entry.key, entry.kdf, Y.encodeStateAsUpdate(entry.doc)),
      );
      await this.store(id, { version: conflict.version, payload, dirty: true });
    } catch (error) {
      if (!(error instanceof WrongPasswordError)) throw error;
      // пароль сменили на другом устройстве: наша версия — отдельной заметкой
      await this.conflictCopy(id, entry);
      await this.store(id, { version: conflict.version, payload: conflict.payload, dirty: false });
      this.lock(id);
      this.workspace.toast(
        'Пароль заметки сменили на другом устройстве. Ваши правки сохранены копией.',
      );
    }
  }
  private async conflictCopy(id: string, entry: Unlocked) {
    const meta = this.workspace.metadata.get(id);
    const copy = uuid();
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(entry.doc));
    const title = `${(meta?.hideTitle ? secureTitle(doc) : meta?.title) || 'Без названия'} (конфликт)`;
    if (meta?.hideTitle) doc.getMap('secure').set('title', title);
    const payload = JSON.stringify(await seal(entry.key, entry.kdf, Y.encodeStateAsUpdate(doc)));
    doc.destroy();
    await this.store(copy, { version: 0, payload, dirty: true });
    this.workspace.addEncryptedNote(copy, {
      title: meta?.hideTitle ? '' : title,
      hideTitle: Boolean(meta?.hideTitle),
      notebookId: meta?.notebookId ?? null,
      sectionId: meta?.sectionId ?? null,
    });
    void this.push(copy);
  }
  private async download(id: string): Promise<LocalRecord | undefined> {
    if (!navigator.onLine) return undefined;
    try {
      const row = await api<{ version: number; payload: string }>(`/api/encrypted/${id}`);
      const record = {
        key: this.recordKey(id),
        version: row.version,
        payload: row.payload,
        dirty: false,
      };
      await this.store(id, record);
      return record;
    } catch {
      return undefined;
    }
  }
  /** Подтянуть изменения с сервера и отправить отложенные. */
  async sync() {
    if (!navigator.onLine) return;
    let remote: { note_id: string; version: number }[];
    try {
      remote = await api('/api/encrypted');
    } catch {
      return;
    }
    const versions = new Map(remote.map((r) => [r.note_id, r.version]));
    for (const [id, note] of this.workspace.metadata) {
      if (!note.encrypted) continue;
      const record = await this.record(id);
      const version = versions.get(id);
      if (record?.dirty) {
        void this.push(id);
        continue;
      }
      if (version === undefined || (record && record.version >= version)) continue;
      const fresh = await this.download(id);
      const entry = this.open.get(id);
      if (fresh && entry)
        try {
          Y.applyUpdate(entry.doc, await unseal(entry.key, parseEnvelope(fresh.payload)), REMOTE);
        } catch {
          this.lock(id); // пароль сменили на другом устройстве
        }
    }
  }
  /** Поставить пароль: открытый текст удаляется с сервера и с устройства. */
  async enable(id: string, password: string, hideTitle: boolean) {
    if (!navigator.onLine) throw new Error('Чтобы поставить пароль, нужно подключение к серверу');
    const meta = this.workspace.metadata.get(id);
    if (!meta) throw new Error('Заметка не найдена');
    const plain = this.workspace.note(id);
    await this.workspace.whenSynced(id);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(plain.doc));
    if (hideTitle) doc.getMap('secure').set('title', meta.title);
    const kdf = newKdf();
    const key = await deriveKey(password, kdf);
    const state = Y.encodeStateAsUpdate(doc);
    doc.destroy();
    const payload = JSON.stringify(await seal(key, kdf, state));
    const result = await api<{ version: number }>(`/api/encrypted/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ version: 0, payload, attachments: attachmentIds(plain.doc) }),
    });
    await this.store(id, { version: result.version, payload, dirty: false });
    this.workspace.dropPlain(id);
    this.workspace.update(
      id,
      { encrypted: true, hideTitle, title: hideTitle ? '' : meta.title },
      false,
    );
    this.attach(id, key, kdf, state);
  }
  async changePassword(id: string, password: string) {
    const entry = this.open.get(id);
    if (!entry) throw new Error('Сначала откройте заметку');
    entry.kdf = newKdf();
    entry.key = await deriveKey(password, entry.kdf);
    await this.save(id);
  }
  /** Снять пароль: заметка снова синхронизируется обычным образом. */
  async disable(id: string) {
    if (!navigator.onLine) throw new Error('Чтобы снять пароль, нужно подключение к серверу');
    const entry = this.open.get(id);
    if (!entry) throw new Error('Сначала откройте заметку');
    if (this.timers.has(id)) await this.save(id);
    await api(`/api/encrypted/${id}`, { method: 'DELETE' });
    const meta = this.workspace.metadata.get(id);
    const state = Y.encodeStateAsUpdate(entry.doc);
    const title = meta?.hideTitle ? secureTitle(entry.doc) : (meta?.title ?? '');
    entry.doc.destroy();
    this.open.delete(id);
    await this.forget(id);
    this.workspace.update(id, { encrypted: false, hideTitle: false, title }, false);
    const plain = this.workspace.note(id);
    await plain.ready;
    Y.applyUpdate(plain.doc, state);
    plain.doc.getMap('secure').clear();
  }
  destroy() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const entry of this.open.values()) entry.doc.destroy();
    this.open.clear();
  }
  /** Стереть локальные копии заметок, которых больше нет. */
  async prune(existing: Set<string>) {
    const keys = await withStore<IDBValidKey[]>('readonly', (s) => s.getAllKeys());
    const prefix = `${this.workspace.userId}:`;
    for (const key of keys)
      if (String(key).startsWith(prefix) && !existing.has(String(key).slice(prefix.length)))
        await withStore('readwrite', (s) => s.delete(key));
  }
}
interface Conflict {
  version: number;
  payload?: string;
}

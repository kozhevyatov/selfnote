/**
 * Заметки под паролем на телефоне — порт apps/web/src/secure.ts.
 * Расшифрованный Y.Doc живёт только в памяти; на телефоне (LocalStore, ключ `secure:<id>`)
 * и на сервере — конверт AES-GCM. Синхронизация — REST с номером версии; при конфликте
 * серверная копия расшифровывается и сливается через Yjs, а если пароль сменили на другом
 * устройстве — свои правки сохраняются отдельной заметкой «(конфликт)».
 * Криптография — shared/secure.ts поверх crypto.subtle из src/crypto/CryptoHost.
 */
import * as Y from 'yjs';
import { deriveKey, parseEnvelope, seal, unseal, WrongPasswordError, type Kdf, type Note } from '@selfnote/shared';

import { api, ApiError } from '../auth';
import { uuid } from '../ids';
import type { LocalStore } from './localStore';

interface LocalRecord {
  version: number;
  payload: string;
  dirty: boolean;
}
interface Unlocked {
  key: Uint8Array;
  kdf: Kdf;
  doc: Y.Doc;
}
interface Conflict {
  version: number;
  payload?: string;
}
const REMOTE = 'secure-remote';

export interface SecureHost {
  metadata: ReadonlyMap<string, Note>;
  online(): boolean;
  addEncrypted(id: string, meta: Pick<Note, 'title' | 'notebookId' | 'sectionId' | 'kind'> & { hideTitle: boolean }): void;
  emit(): void;
}

export function secureTitle(doc: Y.Doc): string {
  return String(doc.getMap('secure').get('title') ?? '');
}
/** id картинок — серверу, чтобы ночная очистка их не удалила. */
function attachmentIds(doc: Y.Doc): string[] {
  const ids = new Set<string>();
  const walk = (node: Y.XmlFragment | Y.XmlElement) => {
    for (const child of node.toArray())
      if (child instanceof Y.XmlElement) {
        const src = child.getAttribute('src');
        if (child.nodeName === 'image' && src?.startsWith('/api/attachments/')) ids.add(src.split('/')[3]);
        walk(child);
      }
  };
  walk(doc.getXmlFragment('content'));
  return [...ids];
}

export class SecureNotes {
  private open = new Map<string, Unlocked>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private saves = new Map<string, Promise<void>>();
  private pushing = new Set<string>();
  constructor(
    private readonly host: SecureHost,
    private readonly store: LocalStore,
  ) {}

  private record(id: string) {
    return this.store.get<LocalRecord>(`secure:${id}`);
  }
  private put(id: string, value: LocalRecord) {
    return this.store.set(`secure:${id}`, value);
  }
  get pending() {
    return this.timers.size > 0 || this.saves.size > 0 || this.pushing.size > 0;
  }
  isUnlocked(id: string) {
    return this.open.has(id);
  }
  doc(id: string): Y.Doc | undefined {
    return this.open.get(id)?.doc;
  }
  docs(): [string, Y.Doc][] {
    return [...this.open].map(([id, e]) => [id, e.doc]);
  }

  /** Расшифровать (копия с телефона, а если её нет — с сервера). Неверный пароль → WrongPasswordError. */
  async unlock(id: string, password: string) {
    let record = await this.record(id);
    if (!record) record = await this.download(id);
    if (!record) throw new Error('Заметка ещё не загружена на телефон. Подключитесь к сети.');
    const envelope = parseEnvelope(record.payload);
    const key = await deriveKey(password, envelope.kdf);
    const state = await unseal(key, envelope);
    this.attach(id, key, envelope.kdf, state);
    if (record.dirty) void this.push(id);
  }
  /** Открыть ключом хранилища паролей (без пароля заметки). */
  async unlockWithKey(id: string, key: Uint8Array) {
    let record = await this.record(id);
    if (!record) record = await this.download(id);
    if (!record) throw new Error('Запись ещё не загружена на телефон. Подключитесь к сети.');
    const envelope = parseEnvelope(record.payload);
    this.attach(id, key, envelope.kdf, await unseal(key, envelope));
    if (record.dirty) void this.push(id);
  }
  /** Новая запись хранилища паролей (как createPasswordNote в вебе). */
  async createPasswordNote(key: Uint8Array, kdf: Kdf, notebookId: string | null, sectionId: string | null) {
    const id = uuid();
    const doc = new Y.Doc();
    doc.getMap('secure').set('title', '');
    doc.getArray('credentials').push([{ id: uuid(), name: '', url: '', login: '', password: '' }]);
    const state = Y.encodeStateAsUpdate(doc);
    doc.destroy();
    const payload = JSON.stringify(await seal(key, kdf, state));
    await this.put(id, { version: 0, payload, dirty: true });
    this.host.addEncrypted(id, { title: '', hideTitle: true, kind: 'passwords', notebookId, sectionId });
    this.attach(id, key, kdf, state);
    void this.push(id);
    return id;
  }
  private attach(id: string, key: Uint8Array, kdf: Kdf, state: Uint8Array) {
    this.open.get(id)?.doc.destroy();
    const doc = new Y.Doc();
    Y.applyUpdate(doc, state, REMOTE);
    doc.on('update', (_u: Uint8Array, origin: unknown) => {
      if (origin !== REMOTE) this.schedule(id);
      this.host.emit();
    });
    this.open.set(id, { key, kdf, doc });
    this.host.emit();
  }
  lock(id: string) {
    const entry = this.open.get(id);
    if (!entry) return;
    if (this.timers.has(id)) void this.save(id).finally(() => entry.doc.destroy());
    else entry.doc.destroy();
    this.open.delete(id);
    this.host.emit();
  }
  /** Уход приложения в фон: всё сохранить и закрыть. */
  lockAll() {
    for (const id of [...this.open.keys()]) this.lock(id);
  }
  private schedule(id: string) {
    clearTimeout(this.timers.get(id));
    this.timers.set(
      id,
      setTimeout(() => void this.save(id).catch(() => undefined), 800),
    );
  }
  save(id: string): Promise<void> {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    const entry = this.open.get(id);
    if (!entry) return Promise.resolve();
    const state = Y.encodeStateAsUpdate(entry.doc);
    const { key, kdf } = entry;
    const previous = this.saves.get(id) ?? Promise.resolve();
    const saving = previous
      .catch(() => undefined)
      .then(async () => {
        const payload = JSON.stringify(await seal(key, kdf, state));
        const record = await this.record(id);
        await this.put(id, { version: record?.version ?? 0, payload, dirty: true });
      });
    this.saves.set(id, saving);
    return saving.then(async () => {
      if (this.saves.get(id) === saving) this.saves.delete(id);
      this.host.emit();
      await this.push(id);
    });
  }
  async push(id: string) {
    if (!this.host.online() || this.pushing.has(id)) return;
    this.pushing.add(id);
    this.host.emit();
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
          const changed = Boolean(latest && latest.payload !== record.payload);
          await this.put(id, { version: result.version, payload: latest?.payload ?? record.payload, dirty: changed });
          if (!changed) return;
        } catch (error) {
          const e = error as ApiError & { data?: Conflict };
          if (e.status !== 409) throw error;
          await this.resolveConflict(id, e.data ?? (await this.conflictData(id)));
        }
      }
    } catch (error) {
      console.warn('[secure] заметка будет отправлена позже', error);
    } finally {
      this.pushing.delete(id);
      this.host.emit();
    }
  }
  /** У ApiError нет тела ответа — серверную копию при конфликте берём отдельным запросом. */
  private async conflictData(id: string): Promise<Conflict> {
    try {
      return await api<{ version: number; payload: string }>(`/api/encrypted/${id}`);
    } catch (error) {
      if ((error as ApiError).status === 404) return { version: 0 };
      throw error;
    }
  }
  private async resolveConflict(id: string, conflict: Conflict) {
    const entry = this.open.get(id);
    if (!conflict.payload) {
      // пароль сняли на другом устройстве — свои правки сохраняем копией
      if (entry) await this.conflictCopy(id, entry);
      await this.store.delete(`secure:${id}`);
      this.lock(id);
      return;
    }
    if (!entry) throw new Error('Нужно открыть заметку, чтобы объединить правки');
    try {
      const state = await unseal(entry.key, parseEnvelope(conflict.payload));
      if (this.host.metadata.get(id)?.kind === 'passwords') {
        // записи паролей не сливаем (массив перезаписывается целиком) — наша версия копией
        await this.conflictCopy(id, entry);
        if (this.open.get(id) === entry) this.attach(id, entry.key, entry.kdf, state);
        await this.put(id, { version: conflict.version, payload: conflict.payload, dirty: false });
        return;
      }
      Y.applyUpdate(entry.doc, state, REMOTE);
      const payload = JSON.stringify(await seal(entry.key, entry.kdf, Y.encodeStateAsUpdate(entry.doc)));
      await this.put(id, { version: conflict.version, payload, dirty: true });
    } catch (error) {
      if (!(error instanceof WrongPasswordError)) throw error;
      await this.conflictCopy(id, entry);
      await this.put(id, { version: conflict.version, payload: conflict.payload, dirty: false });
      this.lock(id);
    }
  }
  private async conflictCopy(id: string, entry: Unlocked) {
    const meta = this.host.metadata.get(id);
    const copy = uuid();
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(entry.doc));
    const title = `${(meta?.hideTitle ? secureTitle(doc) : meta?.title) || 'Без названия'} (конфликт)`;
    if (meta?.hideTitle) doc.getMap('secure').set('title', title);
    const payload = JSON.stringify(await seal(entry.key, entry.kdf, Y.encodeStateAsUpdate(doc)));
    doc.destroy();
    await this.put(copy, { version: 0, payload, dirty: true });
    this.host.addEncrypted(copy, {
      title: meta?.hideTitle ? '' : title,
      hideTitle: Boolean(meta?.hideTitle),
      kind: meta?.kind,
      notebookId: meta?.notebookId ?? null,
      sectionId: meta?.sectionId ?? null,
    });
    void this.push(copy);
  }
  private async download(id: string): Promise<LocalRecord | null> {
    if (!this.host.online()) return null;
    try {
      const row = await api<{ version: number; payload: string }>(`/api/encrypted/${id}`);
      const record = { version: row.version, payload: row.payload, dirty: false };
      await this.put(id, record);
      return record;
    } catch {
      return null;
    }
  }
  /** Подтянуть изменения с сервера и отправить отложенные (при подключении). */
  async sync() {
    if (!this.host.online()) return;
    let remote: { note_id: string; version: number }[];
    try {
      remote = await api('/api/encrypted');
    } catch {
      return;
    }
    const versions = new Map(remote.map((r) => [r.note_id, r.version]));
    for (const [id, note] of this.host.metadata) {
      if (!note.encrypted || note.deletedAt) continue;
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
  destroy() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const entry of this.open.values()) entry.doc.destroy();
    this.open.clear();
  }
}

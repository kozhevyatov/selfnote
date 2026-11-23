/**
 * Хранилище паролей — порт apps/web/src/vault.ts. Мастер-пароль нигде не сохраняется:
 * им расшифровывается случайный ключ хранилища (/api/vault), а уже этим ключом — записи
 * (заметки kind: 'passwords'). Ключ живёт в памяти; блокировка через 5 минут бездействия
 * и при уходе приложения в фон.
 */
import type * as Y from 'yjs';
import { deriveKey, newKdf, parseEnvelope, seal, unseal, type Kdf, type Note } from '@selfnote/shared';
import { api } from '../auth';
import { uuid } from '../ids';
import type { LocalStore } from './localStore';
import type { SecureNotes } from './secure';

export interface Credential {
  id: string;
  name: string;
  url: string;
  login: string;
  password: string;
}
export interface PasswordSnapshot {
  id: string;
  date: string;
  title: string;
  entries: Credential[];
}
/** Снимок записей в зашифрованную историю (как в вебе, до 50 штук). */
export function savePasswordVersion(doc: Y.Doc) {
  const versions = doc.getArray<PasswordSnapshot>('passwordVersions');
  const value = {
    title: doc.getMap<string>('secure').get('title') || '',
    entries: doc.getArray<Credential>('credentials').toArray(),
  };
  const last = versions.length ? versions.get(versions.length - 1) : undefined;
  if (last && JSON.stringify({ title: last.title, entries: last.entries }) === JSON.stringify(value)) return;
  doc.transact(() => {
    versions.push([{ id: uuid(), date: new Date().toISOString(), ...value }]);
    if (versions.length > 50) versions.delete(0, versions.length - 50);
  });
}

export interface VaultHost {
  metadata: ReadonlyMap<string, Note>;
  online(): boolean;
  emit(): void;
}

export class PasswordVault {
  private key: Uint8Array | null = null;
  private kdf: Kdf | null = null;
  private lastActivity = Date.now();
  private generation = 0;
  private timer: ReturnType<typeof setInterval>;
  constructor(
    private readonly host: VaultHost,
    private readonly secure: SecureNotes,
    private readonly store: LocalStore,
  ) {
    this.timer = setInterval(() => {
      if (this.key && Date.now() - this.lastActivity >= 5 * 60_000) this.lock();
    }, 5000);
  }
  get unlocked() {
    return this.key !== null;
  }
  /** Любое действие с паролями откладывает автоблокировку. */
  touch() {
    this.lastActivity = Date.now();
  }
  /** Конверт с ключом хранилища: с сервера (с кэшем на телефоне) или из кэша без сети. */
  async configuration(): Promise<string | null> {
    if (this.host.online())
      try {
        const result = await api<{ payload: string | null }>('/api/vault');
        if (result.payload) await this.store.set('vault', result.payload);
        return result.payload;
      } catch {
        /* ниже — кэш */
      }
    return this.store.get<string>('vault');
  }
  async unlock(password: string, setup: boolean) {
    const generation = this.generation;
    let payload = await this.configuration();
    if (!payload) {
      if (!setup || !this.host.online()) throw new Error('Для первой настройки нужна связь с сервером');
      if (password.length < 12) throw new Error('Мастер-пароль — не меньше 12 символов');
      const kdf = newKdf();
      const key = crypto.getRandomValues(new Uint8Array(32));
      payload = JSON.stringify(await seal(await deriveKey(password, kdf), kdf, key));
      await api('/api/vault', { method: 'POST', body: JSON.stringify({ payload }) });
      await this.store.set('vault', payload);
    } else if (setup) throw new Error('Мастер-пароль уже настроен');
    const envelope = parseEnvelope(payload);
    const key = await unseal(await deriveKey(password, envelope.kdf), envelope);
    if (key.length !== 32) throw new Error('Повреждённый ключ хранилища');
    if (generation !== this.generation) throw new Error('Разблокировка отменена');
    this.key = key;
    this.kdf = envelope.kdf;
    this.touch();
    this.host.emit();
    await Promise.all(
      [...this.host.metadata.values()]
        .filter((note) => note.kind === 'passwords' && !note.deletedAt)
        .map((note) => this.open(note.id).catch(() => undefined)),
    );
  }
  async open(id: string) {
    if (!this.key) throw new Error('Разблокируйте хранилище');
    if (this.secure.isUnlocked(id)) return;
    const generation = this.generation;
    await this.secure.unlockWithKey(id, this.key);
    if (generation !== this.generation) this.secure.lock(id);
  }
  async create(notebookId: string | null, sectionId: string | null) {
    if (!this.key || !this.kdf) throw new Error('Разблокируйте хранилище');
    return this.secure.createPasswordNote(this.key, this.kdf, notebookId, sectionId);
  }
  lock = () => {
    this.generation++;
    const wasOpen = this.key !== null;
    this.key = null;
    this.kdf = null;
    for (const note of this.host.metadata.values())
      if (note.kind === 'passwords') {
        const doc = this.secure.doc(note.id);
        if (doc && !note.deletedAt) savePasswordVersion(doc);
        this.secure.lock(note.id);
      }
    if (wasOpen) this.host.emit();
  };
  destroy() {
    clearInterval(this.timer);
    this.lock();
  }
}

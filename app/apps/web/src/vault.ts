import type * as Y from 'yjs';
import { uuid } from './ids';
import { deriveKey, newKdf, parseEnvelope, seal, unseal, type Kdf } from '@selfnote/shared';
import { api } from './api';
import { useUI, type Workspace } from './store';

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
export function savePasswordVersion(doc: Y.Doc) {
  const versions = doc.getArray<PasswordSnapshot>('passwordVersions');
  const value = {
    title: doc.getMap<string>('secure').get('title') || '',
    entries: doc.getArray<Credential>('credentials').toArray(),
  };
  const last = versions.length ? versions.get(versions.length - 1) : undefined;
  if (
    last &&
    JSON.stringify({ title: last.title, entries: last.entries }) === JSON.stringify(value)
  )
    return;
  doc.transact(() => {
    versions.push([{ id: uuid(), date: new Date().toISOString(), ...value }]);
    if (versions.length > 50) versions.delete(0, versions.length - 50);
  });
}

/** В памяти — только случайный ключ, мастер-пароль нигде не сохраняется. */
export class PasswordVault {
  private key: Uint8Array | null = null;
  private kdf: Kdf | null = null;
  private lastActivity = Date.now();
  private timer: ReturnType<typeof setInterval>;
  private generation = 0;
  private opening = new Map<string, Promise<void>>();
  constructor(private workspace: Workspace) {
    this.timer = setInterval(() => {
      if (this.key && Date.now() - this.lastActivity >= 5 * 60_000) this.lock();
    }, 1000);
    window.addEventListener('pointerdown', this.touch);
    window.addEventListener('keydown', this.touch);
    window.addEventListener('pagehide', this.lock);
    document.addEventListener('visibilitychange', this.onVisibility);
  }
  private touch = () => {
    this.lastActivity = Date.now();
  };
  private onVisibility = () => {
    if (document.hidden) this.lock();
  };
  private cacheKey() {
    return `vault:${this.workspace.userId}`;
  }
  get unlocked() {
    return this.key !== null;
  }
  async configuration() {
    if (navigator.onLine) {
      let result: { payload: string | null };
      try {
        result = await api<{ payload: string | null }>('/api/vault');
      } catch (error) {
        const cached = localStorage.getItem(this.cacheKey());
        if (cached) return cached;
        throw error;
      }
      if (result.payload) localStorage.setItem(this.cacheKey(), result.payload);
      return result.payload;
    }
    return localStorage.getItem(this.cacheKey());
  }
  async unlock(password: string, setup: boolean) {
    const generation = this.generation;
    let payload = await this.configuration();
    if (!payload) {
      if (!setup || !navigator.onLine)
        throw new Error('Для первой настройки требуется подключение к серверу');
      if (password.length < 12)
        throw new Error('Мастер-пароль должен содержать не меньше 12 символов');
      const kdf = newKdf();
      const key = crypto.getRandomValues(new Uint8Array(32));
      payload = JSON.stringify(await seal(await deriveKey(password, kdf), kdf, key));
      await api('/api/vault', { method: 'POST', body: JSON.stringify({ payload }) });
      localStorage.setItem(this.cacheKey(), payload);
    } else if (setup) throw new Error('Мастер-пароль уже настроен. Откройте окно заново.');
    const envelope = parseEnvelope(payload);
    const key = await unseal(await deriveKey(password, envelope.kdf), envelope);
    if (key.length !== 32) throw new Error('Повреждённый ключ хранилища');
    if (generation !== this.generation) throw new Error('Разблокировка отменена');
    this.key = key;
    this.kdf = envelope.kdf;
    this.touch();
    this.workspace.emit();
    await Promise.all(
      [...this.workspace.metadata.values()]
        .filter((note) => note.kind === 'passwords')
        .map((note) =>
          this.open(note.id).catch(() => {
            /* Не загруженные офлайн записи откроются при подключении. */
          }),
        ),
    );
  }
  async open(id: string) {
    if (!this.key) throw new Error('Разблокируйте хранилище');
    if (this.workspace.secure.isUnlocked(id)) return;
    const pending = this.opening.get(id);
    if (pending) return pending;
    const generation = this.generation;
    const opening = this.workspace.secure
      .unlockWithKey(id, this.key)
      .then(() => {
        if (generation !== this.generation) this.workspace.secure.lock(id);
      })
      .finally(() => {
        this.opening.delete(id);
      });
    this.opening.set(id, opening);
    return opening;
  }
  async create() {
    if (!this.key || !this.kdf) throw new Error('Разблокируйте хранилище');
    const generation = this.generation;
    const filter = useUI.getState().filter;
    const section = this.workspace.sections.get(filter);
    const id = await this.workspace.secure.createPasswordNote(
      this.key,
      this.kdf,
      section?.notebookId ?? (this.workspace.notebooks.has(filter) ? filter : null),
      section?.id ?? null,
    );
    if (generation !== this.generation) this.workspace.secure.lock(id);
    useUI.getState().select(id);
  }
  lock = () => {
    this.generation++;
    this.key = null;
    this.kdf = null;
    for (const note of this.workspace.metadata.values())
      if (note.kind === 'passwords') {
        const doc = this.workspace.secure.doc(note.id);
        if (doc && !note.deletedAt) savePasswordVersion(doc);
        this.workspace.secure.lock(note.id);
      }
    this.workspace.emit();
  };
  destroy() {
    clearInterval(this.timer);
    window.removeEventListener('pointerdown', this.touch);
    window.removeEventListener('keydown', this.touch);
    window.removeEventListener('pagehide', this.lock);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.lock();
  }
}

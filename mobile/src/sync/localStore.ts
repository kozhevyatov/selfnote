/**
 * Офлайн-хранилище на устройстве (замена y-indexeddb из веба): состояние каждого
 * Y.Doc в SQLite плюс небольшие значения (кэш списка общих заметок).
 * Отдельная база на каждый аккаунт и сервер.
 */
import * as SQLite from 'expo-sqlite';
import * as Y from 'yjs';

export const LOCAL_ORIGIN = Symbol('local');

function hash(value: string) {
  let h = 5381;
  for (let i = 0; i < value.length; i++) h = ((h << 5) + h + value.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export class LocalStore {
  private pending = new Map<string, Y.Doc>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private constructor(private readonly db: SQLite.SQLiteDatabase) {}

  static async open(server: string, userId: string) {
    const db = await SQLite.openDatabaseAsync(`selfnote-${hash(server)}-${userId}.db`);
    await db.execAsync(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS docs (
        name TEXT PRIMARY KEY NOT NULL,
        state BLOB NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
    `);
    return new LocalStore(db);
  }

  /** Подключает документ: загружает сохранённое состояние и сохраняет каждое изменение. */
  async bind(name: string, doc: Y.Doc) {
    doc.on('update', (_update: Uint8Array, origin: unknown) => {
      if (origin === LOCAL_ORIGIN || this.closed) return;
      this.pending.set(name, doc);
      this.timer ??= setTimeout(() => void this.flush(), 400);
    });
    const row = await this.db.getFirstAsync<{ state: Uint8Array }>(
      'SELECT state FROM docs WHERE name = ?',
      [name],
    );
    if (row?.state?.length) Y.applyUpdate(doc, new Uint8Array(row.state), LOCAL_ORIGIN);
  }

  /** Записывает накопленные изменения (вызывается и при уходе приложения в фон). */
  async flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    const batch = [...this.pending];
    this.pending.clear();
    if (!batch.length || this.closed) return;
    const now = Date.now();
    await this.db.withTransactionAsync(async () => {
      for (const [name, doc] of batch)
        await this.db.runAsync(
          `INSERT INTO docs (name, state, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
          [name, Y.encodeStateAsUpdate(doc), now],
        );
    });
  }

  async get<T>(key: string): Promise<T | null> {
    const row = await this.db.getFirstAsync<{ value: string }>('SELECT value FROM kv WHERE key = ?', [
      key,
    ]);
    try {
      return row ? (JSON.parse(row.value) as T) : null;
    } catch {
      return null;
    }
  }
  async set(key: string, value: unknown) {
    if (this.closed) return;
    await this.db.runAsync(
      'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [key, JSON.stringify(value)],
    );
  }

  async close() {
    await this.flush().catch(() => undefined);
    this.closed = true;
    await this.db.closeAsync().catch(() => undefined);
  }
}

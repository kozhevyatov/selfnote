import { Kysely, type Generated, SqliteDialect, MysqlDialect, Migrator, sql } from 'kysely';
import SQLite from 'better-sqlite3';
import { createPool } from 'mysql2';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import * as Y from 'yjs';
import { extractDocument, deletedNoteIds, uniqueTasks } from '@selfnote/shared';
import { fileURLToPath } from 'node:url';
export const dataDir = path.resolve(
  process.env.DATA_DIR || fileURLToPath(new URL('../../../../data/', import.meta.url)),
);
export type Config =
  | { type: 'sqlite' }
  | {
      type: 'mariadb';
      host: string;
      port: number;
      database: string;
      user: string;
      password: string;
    };
interface Database {
  users: {
    id: string;
    email: string;
    name: string;
    password_hash: string;
    role: string;
    created_at: string;
  };
  sessions: {
    id: string;
    user_id: string;
    token_hash: string;
    expires_at: string;
    created_at: string;
  };
  settings: { key: string; value: string };
  yjs_documents: { name: string; owner_id: string; state: Buffer; updated_at: string };
  notes_index: {
    note_id: string;
    owner_id: string;
    plain_text: string;
    preview: string;
    updated_at: string;
    deleted: number;
    deleted_at: Generated<string | null>;
  };
  tasks: {
    id: string;
    note_id: string;
    owner_id: string;
    text: string;
    checked: number;
    due: string | null;
    done_at: string | null;
    position: number;
  };
  purged_notes: { note_id: string; owner_id: string };
  note_versions: {
    label: Generated<string | null>;
    id: string;
    note_id: string;
    author: string;
    state: Buffer;
    created_at: string;
  };
  attachments: { id: string; owner_id: string; filename: string; mime: string; created_at: string };
  /** Заметки под паролем: сервер хранит только зашифрованный снапшот (см. shared/secure.ts). */
  encrypted_notes: {
    note_id: string;
    owner_id: string;
    version: number;
    payload: string;
    /** Картинки заметки (id вложений) — чтобы ночная очистка их не удалила. */
    attachments: string;
    updated_at: string;
  };
  shares: {
    id: string;
    token: string;
    note_id: string;
    owner_id: string;
    password_hash: string | null;
    expires_at: string | null;
    encrypted: number;
    views: Generated<number>;
    created_at: string;
  };
}
export type DB = Kysely<Database>;
export let db: DB | undefined;
/** Тип активной базы: от него зависит полнотекстовый поиск. */
export let dbType: Config['type'] = 'sqlite';
export async function openDatabase(config: Config): Promise<DB> {
  await mkdir(dataDir, { recursive: true });
  const conn = new Kysely<Database>({
    dialect:
      config.type === 'sqlite'
        ? new SqliteDialect({
            database: (() => {
              const sqlite = new SQLite(path.join(dataDir, 'selfnote.sqlite'));
              sqlite.pragma('journal_mode = WAL');
              sqlite.pragma('foreign_keys = ON');
              return sqlite;
            })(),
          })
        : new MysqlDialect({
            pool: createPool({ ...config, connectionLimit: 5, charset: 'utf8mb4' }),
          }),
  });
  const blob = config.type === 'sqlite' ? 'blob' : 'longblob';
  const migrator = new Migrator({
    db: conn,
    provider: {
      getMigrations: async () => ({
        '001_foundation': {
          up: async (d: Kysely<unknown>) => {
            await d.schema
              .createTable('users')
              .addColumn('id', 'varchar(36)', (c) => c.primaryKey())
              .addColumn('email', 'varchar(254)', (c) => c.notNull().unique())
              .addColumn('name', 'varchar(120)', (c) => c.notNull())
              .addColumn('password_hash', 'text', (c) => c.notNull())
              .addColumn('role', 'varchar(20)', (c) => c.notNull())
              .addColumn('created_at', 'varchar(30)', (c) => c.notNull())
              .execute();
            await d.schema
              .createTable('sessions')
              .addColumn('id', 'varchar(36)', (c) => c.primaryKey())
              .addColumn('user_id', 'varchar(36)', (c) =>
                c.notNull().references('users.id').onDelete('cascade'),
              )
              .addColumn('token_hash', 'varchar(64)', (c) => c.notNull().unique())
              .addColumn('expires_at', 'varchar(30)', (c) => c.notNull())
              .addColumn('created_at', 'varchar(30)', (c) => c.notNull())
              .execute();
            await d.schema
              .createTable('settings')
              .addColumn('key', 'varchar(100)', (c) => c.primaryKey())
              .addColumn('value', 'text', (c) => c.notNull())
              .execute();
            await d.schema
              .createTable('yjs_documents')
              .addColumn('name', 'varchar(80)', (c) => c.primaryKey())
              .addColumn('owner_id', 'varchar(36)', (c) => c.notNull())
              .addColumn('state', sql.raw(blob), (c) => c.notNull())
              .addColumn('updated_at', 'varchar(30)', (c) => c.notNull())
              .execute();
            await d.schema
              .createTable('notes_index')
              .addColumn('note_id', 'varchar(36)', (c) => c.primaryKey())
              .addColumn('owner_id', 'varchar(36)', (c) => c.notNull())
              .addColumn('plain_text', 'text', (c) => c.notNull())
              .addColumn('preview', 'text', (c) => c.notNull())
              .addColumn('updated_at', 'varchar(30)', (c) => c.notNull())
              .execute();
            await d.schema
              .createTable('tasks')
              .addColumn('id', 'varchar(36)', (c) => c.primaryKey())
              .addColumn('note_id', 'varchar(36)', (c) => c.notNull())
              .addColumn('owner_id', 'varchar(36)', (c) => c.notNull())
              .addColumn('text', 'text', (c) => c.notNull())
              .addColumn('checked', 'integer', (c) => c.notNull())
              .addColumn('due', 'varchar(40)')
              .addColumn('done_at', 'varchar(30)')
              .addColumn('position', 'integer', (c) => c.notNull())
              .execute();
            await d.schema.createIndex('tasks_note').on('tasks').column('note_id').execute();
            await d.schema
              .createTable('note_versions')
              .addColumn('id', 'varchar(36)', (c) => c.primaryKey())
              .addColumn('note_id', 'varchar(36)', (c) => c.notNull())
              .addColumn('author', 'varchar(36)', (c) => c.notNull())
              .addColumn('state', sql.raw(blob), (c) => c.notNull())
              .addColumn('created_at', 'varchar(30)', (c) => c.notNull())
              .execute();
            await d.schema
              .createIndex('versions_note')
              .on('note_versions')
              .columns(['note_id', 'created_at'])
              .execute();
            await d.schema
              .createTable('attachments')
              .addColumn('id', 'varchar(64)', (c) => c.notNull())
              .addColumn('owner_id', 'varchar(36)', (c) => c.notNull())
              .addColumn('filename', 'varchar(80)', (c) => c.notNull())
              .addColumn('mime', 'varchar(80)', (c) => c.notNull())
              .addColumn('created_at', 'varchar(30)', (c) => c.notNull())
              .addPrimaryKeyConstraint('attachments_pk', ['id', 'owner_id'])
              .execute();
          },
        },
        '003_history_and_trash': {
          up: async (d: Kysely<unknown>) => {
            await d.schema
              .alterTable('notes_index')
              .addColumn('deleted_at', 'varchar(30)')
              .execute();
            await d.schema.alterTable('note_versions').addColumn('label', 'varchar(40)').execute();
            await d.schema
              .createTable('purged_notes')
              .addColumn('note_id', 'varchar(36)', (c) => c.primaryKey())
              .addColumn('owner_id', 'varchar(36)', (c) => c.notNull())
              .execute();
            const typed = d as DB;
            const spaces = await typed
              .selectFrom('yjs_documents')
              .select(['state', 'owner_id'])
              .where('name', 'like', 'space:%')
              .execute();
            for (const row of spaces) {
              const doc = new Y.Doc();
              try {
                Y.applyUpdate(doc, row.state);
                for (const [id, value] of doc.getMap('notes')) {
                  const date =
                    value instanceof Y.Map
                      ? value.get('deletedAt')
                      : (value as { deletedAt?: unknown })?.deletedAt;
                  if (typeof date === 'string')
                    await typed
                      .updateTable('notes_index')
                      .set({ deleted_at: date })
                      .where('owner_id', '=', row.owner_id)
                      .where('note_id', '=', id)
                      .execute();
                }
              } finally {
                doc.destroy();
              }
            }
          },
        },
        '004_search': {
          up: async (d: Kysely<unknown>) => {
            if (config.type === 'mariadb') {
              await sql`ALTER TABLE notes_index ADD FULLTEXT INDEX notes_fulltext (plain_text)`.execute(
                d,
              );
              return;
            }
            // FTS5 поверх notes_index (external content): триггеры держат индекс в актуальном
            // состоянии и при восстановлении из резервной копии. В бэкап таблицы notes_fts* не идут.
            await sql`CREATE VIRTUAL TABLE notes_fts USING fts5(plain_text, content='notes_index', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2')`.execute(
              d,
            );
            await sql`CREATE TRIGGER notes_fts_insert AFTER INSERT ON notes_index BEGIN
              INSERT INTO notes_fts(rowid, plain_text) VALUES (new.rowid, new.plain_text);
            END`.execute(d);
            await sql`CREATE TRIGGER notes_fts_delete AFTER DELETE ON notes_index BEGIN
              INSERT INTO notes_fts(notes_fts, rowid, plain_text) VALUES ('delete', old.rowid, old.plain_text);
            END`.execute(d);
            await sql`CREATE TRIGGER notes_fts_update AFTER UPDATE OF plain_text ON notes_index BEGIN
              INSERT INTO notes_fts(notes_fts, rowid, plain_text) VALUES ('delete', old.rowid, old.plain_text);
              INSERT INTO notes_fts(rowid, plain_text) VALUES (new.rowid, new.plain_text);
            END`.execute(d);
            await sql`INSERT INTO notes_fts(notes_fts) VALUES ('rebuild')`.execute(d);
          },
        },
        '005_encryption_and_shares': {
          up: async (d: Kysely<unknown>) => {
            const text = config.type === 'sqlite' ? 'text' : 'longtext';
            await d.schema
              .createTable('encrypted_notes')
              .addColumn('note_id', 'varchar(36)', (c) => c.primaryKey())
              .addColumn('owner_id', 'varchar(36)', (c) => c.notNull())
              .addColumn('version', 'integer', (c) => c.notNull())
              .addColumn('payload', sql.raw(text), (c) => c.notNull())
              .addColumn('attachments', 'text', (c) => c.notNull())
              .addColumn('updated_at', 'varchar(30)', (c) => c.notNull())
              .execute();
            await d.schema
              .createIndex('encrypted_owner')
              .on('encrypted_notes')
              .column('owner_id')
              .execute();
            await d.schema
              .createTable('shares')
              .addColumn('id', 'varchar(36)', (c) => c.primaryKey())
              .addColumn('token', 'varchar(64)', (c) => c.notNull().unique())
              .addColumn('note_id', 'varchar(36)', (c) => c.notNull())
              .addColumn('owner_id', 'varchar(36)', (c) => c.notNull())
              .addColumn('password_hash', 'text')
              .addColumn('expires_at', 'varchar(30)')
              .addColumn('encrypted', 'integer', (c) => c.notNull().defaultTo(0))
              .addColumn('views', 'integer', (c) => c.notNull().defaultTo(0))
              .addColumn('created_at', 'varchar(30)', (c) => c.notNull())
              .execute();
            await d.schema.createIndex('shares_note').on('shares').column('note_id').execute();
            await d.schema.createIndex('shares_owner').on('shares').column('owner_id').execute();
          },
        },
        '002_task_keys_and_trash': {
          up: async (raw: Kysely<unknown>) => {
            const d = raw as unknown as Kysely<Database>;
            // id задачи уникален только внутри заметки: при копировании пункта
            // в другую заметку id совпадал и сохранение второй заметки падало.
            await d.schema.dropTable('tasks').execute();
            await d.schema
              .createTable('tasks')
              .addColumn('id', 'varchar(36)', (c) => c.notNull())
              .addColumn('note_id', 'varchar(36)', (c) => c.notNull())
              .addColumn('owner_id', 'varchar(36)', (c) => c.notNull())
              .addColumn('text', 'text', (c) => c.notNull())
              .addColumn('checked', 'integer', (c) => c.notNull())
              .addColumn('due', 'varchar(40)')
              .addColumn('done_at', 'varchar(30)')
              .addColumn('position', 'integer', (c) => c.notNull())
              .addPrimaryKeyConstraint('tasks_pk', ['note_id', 'id'])
              .execute();
            await d.schema.createIndex('tasks_owner').on('tasks').column('owner_id').execute();
            await d.schema
              .alterTable('notes_index')
              .addColumn('deleted', 'integer', (c) => c.notNull().defaultTo(0))
              .execute();
            // восстановить производные данные из сохранённых документов
            const docs = await d.selectFrom('yjs_documents').selectAll().execute();
            for (const row of docs) {
              const doc = new Y.Doc();
              try {
                Y.applyUpdate(doc, row.state);
                if (row.name.startsWith('note:')) {
                  const noteId = row.name.slice(5);
                  const tasks = uniqueTasks(extractDocument(doc).tasks);
                  if (tasks.length)
                    await d
                      .insertInto('tasks')
                      .values(
                        tasks.map((t) => ({
                          id: t.id,
                          note_id: noteId,
                          owner_id: row.owner_id,
                          text: t.text,
                          checked: Number(t.checked),
                          due: t.due,
                          done_at: t.doneAt,
                          position: t.position,
                        })),
                      )
                      .execute();
                } else if (row.name.startsWith('space:')) {
                  const deleted = [...deletedNoteIds(doc)];
                  if (deleted.length)
                    await d
                      .updateTable('notes_index')
                      .set({ deleted: 1 })
                      .where('owner_id', '=', row.owner_id)
                      .where('note_id', 'in', deleted)
                      .execute();
                }
              } finally {
                doc.destroy();
              }
            }
          },
        },
      }),
    },
  });
  const result = await migrator.migrateToLatest();
  if (result.error) {
    await conn.destroy();
    throw result.error;
  }
  return conn;
}
export async function loadDatabase() {
  try {
    const config = JSON.parse(
      await readFile(path.join(dataDir, 'database.json'), 'utf8'),
    ) as Config;
    db = await openDatabase(config);
    dbType = config.type;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
export async function activateDatabase(conn: DB, config: Config) {
  await writeFile(path.join(dataDir, 'database.json.tmp'), JSON.stringify(config), { mode: 0o600 });
  await rename(path.join(dataDir, 'database.json.tmp'), path.join(dataDir, 'database.json'));
  db = conn;
  dbType = config.type;
}

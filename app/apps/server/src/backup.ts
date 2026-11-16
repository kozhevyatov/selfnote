/**
 * Резервные копии: логический дамп всех таблиц (одинаково для SQLite и MariaDB,
 * поэтому копию SQLite можно восстановить в MariaDB и наоборот) + картинки.
 * Формат — ZIP: manifest.json, tables/<таблица>.jsonl, attachments/<владелец>/<файл>.
 */
import { mkdir, readdir, readFile, rm, stat, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import type { Kysely } from 'kysely';
import { readZip, readZipText, writeZip, backupsToKeep, type ZipInput } from '@selfnote/shared';
import { dataDir, type DB } from './db.js';

type AnyDB = Kysely<Record<string, Record<string, unknown>>>;
const FORMAT = 'selfnote-backup';
const NAME = /^selfnote-backup-\d{4}-\d{2}-\d{2}_\d{6}(-[a-z-]+)?\.zip$/;

export const backupDir = () =>
  path.resolve(process.env.BACKUP_DIR || path.join(dataDir, 'backups'));
export const backupHour = () =>
  Math.min(23, Math.max(0, Number(process.env.BACKUP_HOUR ?? 4) || 0));
export const backupsEnabled = () => process.env.BACKUP_ENABLED !== 'false';
export const isBackupName = (name: string) => NAME.test(name);

export interface BackupInfo {
  name: string;
  size: number;
  created_at: string;
  kind: 'auto' | 'manual' | 'before-restore' | 'other';
}
export interface BackupStatus {
  lastAttempt?: string;
  lastSuccess?: string;
  lastFile?: string;
  lastError?: string | null;
  lastAutoDay?: string;
}
interface Manifest {
  format: string;
  version: number;
  createdAt: string;
  database: string;
  migrations: string[];
  tables: Record<string, number>;
  attachments: number;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
const localDay = (d = new Date()) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const statusFile = () => path.join(backupDir(), 'status.json');

export async function readStatus(): Promise<BackupStatus> {
  try {
    return JSON.parse(await readFile(statusFile(), 'utf8')) as BackupStatus;
  } catch {
    return {};
  }
}
async function writeStatus(patch: BackupStatus) {
  await mkdir(backupDir(), { recursive: true });
  const next = { ...(await readStatus()), ...patch };
  await writeFile(statusFile() + '.tmp', JSON.stringify(next, null, 2));
  await rename(statusFile() + '.tmp', statusFile());
}

export async function listBackups(): Promise<BackupInfo[]> {
  let names: string[] = [];
  try {
    names = await readdir(backupDir());
  } catch {
    return [];
  }
  const result: BackupInfo[] = [];
  for (const name of names.filter(isBackupName)) {
    const info = await stat(path.join(backupDir(), name));
    const kind = name.includes('-auto')
      ? 'auto'
      : name.includes('-manual')
        ? 'manual'
        : name.includes('-before-restore')
          ? 'before-restore'
          : 'other';
    result.push({ name, size: info.size, created_at: info.mtime.toISOString(), kind });
  }
  return result.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

async function migrations(db: AnyDB): Promise<string[]> {
  const rows = await db.selectFrom('kysely_migration').select('name').orderBy('name').execute();
  return rows.map((r) => String(r.name));
}
async function dataTables(db: AnyDB) {
  const tables = await db.introspection.getTables();
  return (
    tables
      // notes_fts* — служебные таблицы полнотекстового индекса SQLite, их ведут триггеры
      .filter((t) => !t.name.startsWith('kysely_migration') && !t.name.startsWith('notes_fts'))
      .map((t) => ({ name: t.name, columns: new Set(t.columns.map((c) => c.name)) }))
      .sort((a, b) =>
        a.name === 'users' ? -1 : b.name === 'users' ? 1 : a.name.localeCompare(b.name),
      )
  );
}
function encodeRow(row: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row))
    out[key] =
      value instanceof Uint8Array ? { $b64: Buffer.from(value).toString('base64') } : value;
  return out;
}
function decodeRow(row: Record<string, unknown>, columns: Set<string>) {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (!columns.has(key)) continue;
    out[key] =
      value && typeof value === 'object' && '$b64' in value
        ? Buffer.from(String((value as { $b64: string }).$b64), 'base64')
        : value;
  }
  return out;
}
async function walk(dir: string, prefix = ''): Promise<string[]> {
  let items: import('node:fs').Dirent[] = [];
  try {
    items = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const item of items) {
    const rel = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) files.push(...(await walk(path.join(dir, item.name), rel)));
    else if (item.isFile()) files.push(rel);
  }
  return files;
}

/** Создать резервную копию. Таблицы читаются в одной транзакции — снимок согласован. */
export async function createBackup(
  database: DB,
  kind: 'auto' | 'manual' | 'before-restore',
  dbType: string,
): Promise<BackupInfo> {
  const db = database as unknown as AnyDB;
  const started = new Date();
  await writeStatus({ lastAttempt: started.toISOString() });
  try {
    const files: ZipInput[] = [];
    const manifest: Manifest = {
      format: FORMAT,
      version: 1,
      createdAt: started.toISOString(),
      database: dbType,
      migrations: await migrations(db),
      tables: {},
      attachments: 0,
    };
    await db.transaction().execute(async (trx) => {
      for (const table of await dataTables(trx as unknown as AnyDB)) {
        const rows = await trx.selectFrom(table.name).selectAll().execute();
        manifest.tables[table.name] = rows.length;
        files.push({
          name: `tables/${table.name}.jsonl`,
          data: rows.map((r) => JSON.stringify(encodeRow(r))).join('\n'),
        });
      }
    });
    const attachmentsDir = path.join(dataDir, 'attachments');
    for (const rel of await walk(attachmentsDir)) {
      files.push({
        name: `attachments/${rel}`,
        data: await readFile(path.join(attachmentsDir, rel)),
      });
      manifest.attachments++;
    }
    files.unshift({ name: 'manifest.json', data: JSON.stringify(manifest, null, 2) });
    const zip = await writeZip(files, true);
    const stamp = `${localDay(started)}_${pad(started.getHours())}${pad(started.getMinutes())}${pad(started.getSeconds())}`;
    const name = `selfnote-backup-${stamp}-${kind}.zip`;
    await mkdir(backupDir(), { recursive: true });
    await writeFile(path.join(backupDir(), name + '.tmp'), zip);
    await rename(path.join(backupDir(), name + '.tmp'), path.join(backupDir(), name));
    await writeStatus({
      lastSuccess: new Date().toISOString(),
      lastFile: name,
      lastError: null,
      ...(kind === 'auto' ? { lastAutoDay: localDay(started) } : {}),
    });
    await pruneBackups();
    return { name, size: zip.length, created_at: started.toISOString(), kind };
  } catch (error) {
    await writeStatus({ lastError: (error as Error).message || String(error) });
    throw error;
  }
}

/** Удалить лишние копии по правилу 7 дней / 4 недели / 6 месяцев. */
export async function pruneBackups() {
  // Ротации подлежат только автоматические копии; ручные и «перед восстановлением» удаляет админ.
  const auto = (await listBackups()).filter((b) => b.kind === 'auto');
  const keep = backupsToKeep(auto);
  for (const b of auto)
    if (!keep.has(b.name)) await rm(path.join(backupDir(), b.name), { force: true });
}

export interface RestoreResult {
  tables: Record<string, number>;
  attachments: number;
  createdAt: string;
}
/** Проверить архив и прочитать manifest, ничего не меняя. */
export async function inspectBackup(bytes: Uint8Array) {
  const entries = readZip(bytes);
  const entry = entries.find((e) => e.name === 'manifest.json');
  if (!entry)
    throw Object.assign(new Error('Это не резервная копия SelfNote'), { statusCode: 400 });
  const manifest = JSON.parse(await readZipText(entry)) as Manifest;
  if (manifest.format !== FORMAT)
    throw Object.assign(new Error('Это не резервная копия SelfNote'), { statusCode: 400 });
  return { entries, manifest };
}

/**
 * Восстановить копию в базу (данные в базе заменяются). Копия из более старой версии
 * подходит: новые колонки получат значения по умолчанию. Из более новой — нет.
 */
export async function restoreBackup(database: DB, bytes: Uint8Array): Promise<RestoreResult> {
  const db = database as unknown as AnyDB;
  const { entries, manifest } = await inspectBackup(bytes);
  const known = new Set(await migrations(db));
  const unknown = manifest.migrations.filter((m) => !known.has(m));
  if (unknown.length)
    throw Object.assign(
      new Error('Копия сделана более новой версией SelfNote. Сначала обновите сервис.'),
      { statusCode: 409 },
    );
  const tables = await dataTables(db);
  const byName = new Map(tables.map((t) => [t.name, t]));
  const restored: Record<string, number> = {};
  await db.transaction().execute(async (trx) => {
    for (const table of [...tables].reverse()) await trx.deleteFrom(table.name).execute();
    for (const table of tables) {
      const entry = entries.find((e) => e.name === `tables/${table.name}.jsonl`);
      restored[table.name] = 0;
      if (!entry) continue;
      const text = await readZipText(entry);
      const rows = text
        ? text.split('\n').map((l) => decodeRow(JSON.parse(l), byName.get(table.name)!.columns))
        : [];
      let batch: Record<string, unknown>[] = [];
      let bytesInBatch = 0;
      const flush = async () => {
        if (batch.length) await trx.insertInto(table.name).values(batch).execute();
        batch = [];
        bytesInBatch = 0;
      };
      for (const row of rows) {
        batch.push(row);
        bytesInBatch += JSON.stringify(row).length;
        if (batch.length >= 200 || bytesInBatch > 2_000_000) await flush();
      }
      await flush();
      restored[table.name] = rows.length;
    }
  });
  const attachmentsDir = path.join(dataDir, 'attachments');
  let attachments = 0;
  for (const entry of entries) {
    if (!entry.name.startsWith('attachments/')) continue;
    const target = path.resolve(attachmentsDir, entry.name.slice('attachments/'.length));
    if (!target.startsWith(attachmentsDir + path.sep)) continue; // защита от ../
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, await entry.read());
    attachments++;
  }
  return { tables: restored, attachments, createdAt: manifest.createdAt };
}

/** Ночные копии: проверка раз в 10 минут, одна автоматическая копия в сутки после BACKUP_HOUR. */
export function scheduleBackups(run: () => Promise<void>) {
  const tick = async () => {
    if (!backupsEnabled()) return;
    const now = new Date();
    if (now.getHours() < backupHour()) return;
    const status = await readStatus();
    if (status.lastAutoDay === localDay(now)) return;
    await run();
  };
  const timer = setInterval(() => void tick().catch(() => undefined), 600000);
  timer.unref();
  return timer;
}

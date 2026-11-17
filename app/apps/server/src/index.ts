import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import serveStatic from '@fastify/static';
import { Hocuspocus } from '@hocuspocus/server';
import { sql, type SqlBool } from 'kysely';
import argon2 from 'argon2';
import sharp from 'sharp';
import * as Y from 'yjs';
import { z } from 'zod';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, access, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractDocument,
  expiredNoteIds,
  restoreContent,
  deletedNoteIds,
  uniqueTasks,
  versionsToKeep,
  searchTerms,
  snippet,
  renderDocument,
  localDate,
  type Note,
  type NoteRole,
  type CollaborationList,
} from '@selfnote/shared';
import {
  db,
  dbType,
  dataDir,
  loadDatabase,
  openDatabase,
  activateDatabase,
  type DB,
} from './db.js';
import { shareAssets, sharePage, unavailablePage, SHARE_CSP } from './share-page.js';
import {
  backupDir,
  backupHour,
  backupsEnabled,
  createBackup,
  inspectBackup,
  isBackupName,
  listBackups,
  readStatus,
  restoreBackup,
  scheduleBackups,
} from './backup.js';
import { createReadStream } from 'node:fs';
z.config(z.locales.ru());
await mkdir(dataDir, { recursive: true });
const keyPath = path.join(dataDir, 'jwt.key');
let secret = process.env.JWT_SECRET;
if (!secret) {
  try {
    secret = await readFile(keyPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    secret = randomBytes(48).toString('base64url');
    await writeFile(keyPath, secret, { mode: 0o600, flag: 'wx' });
  }
}
await loadDatabase();
const webRoot = fileURLToPath(new URL('../../web/dist/', import.meta.url));
const app = Fastify({
  logger: true,
  bodyLimit: 1024 * 1024,
  trustProxy: process.env.TRUST_PROXY === 'true',
});
await app.register(cookie);
await app.register(jwt, { secret });
await app.register(rateLimit, { global: false });
await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024, files: 1 } });
await app.register(websocket, { options: { maxPayload: 24 * 1024 * 1024 } });
// Форма пароля публичной ссылки работает и без JavaScript.
app.addContentTypeParser(
  'application/x-www-form-urlencoded',
  { parseAs: 'string', bodyLimit: 4096 },
  (_request, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body)))),
);
const secure = process.env.COOKIE_SECURE === 'true';
const cookieOptions = {
  httpOnly: true,
  secure,
  sameSite: 'strict' as const,
  path: '/api',
  maxAge: 30 * 86400,
};
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const credentials = z.object({
  email: z
    .email()
    .max(254)
    .transform((v) => v.toLowerCase().trim()),
  password: z.string().min(10).max(256),
});
const registration = credentials.extend({ name: z.string().trim().min(1).max(120) });
function database(): DB {
  if (!db) throw Object.assign(new Error('Сначала настройте сервис'), { statusCode: 503 });
  return db;
}
async function userId(request: import('fastify').FastifyRequest): Promise<string> {
  await request.jwtVerify();
  const claims = request.user as { sub: string; sid: string };
  const session = await database()
    .selectFrom('sessions')
    .select('id')
    .where('id', '=', claims.sid)
    .where('user_id', '=', claims.sub)
    .where('expires_at', '>', new Date().toISOString())
    .executeTakeFirst();
  if (!session) throw Object.assign(new Error('Сессия завершена'), { statusCode: 401 });
  return claims.sub;
}
app.addHook('onRequest', async (request, reply) => {
  if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method) && request.headers.origin) {
    const origin = new URL(request.headers.origin);
    if (origin.host !== request.headers.host && origin.origin !== process.env.APP_ORIGIN)
      return reply.code(403).send({ message: 'Недопустимый источник запроса' });
  }
});
app.setErrorHandler((error, request, reply) => {
  const e = error as Error & { statusCode?: number };
  if (e instanceof z.ZodError)
    return reply.code(400).send({
      message: 'Проверьте заполненные поля: ' + e.issues.map((i) => i.message).join(', '),
    });
  request.log.error(error);
  reply.code(e.statusCode || 500).send({
    message:
      e.statusCode && e.statusCode < 500
        ? e.message
        : 'Не удалось выполнить запрос. Подробности в журнале сервера.',
  });
});
async function issueSession(
  user: { id: string; name: string; email: string; role?: string },
  reply: import('fastify').FastifyReply,
) {
  const token = randomBytes(32).toString('base64url');
  const sid = randomUUID();
  const now = new Date();
  await database()
    .insertInto('sessions')
    .values({
      id: sid,
      user_id: user.id,
      token_hash: hash(token),
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 30 * 86400000).toISOString(),
    })
    .execute();
  reply.setCookie('refresh', token, cookieOptions);
  return {
    accessToken: app.jwt.sign({ sub: user.id, sid }, { expiresIn: '15m' }),
    user: { id: user.id, name: user.name, email: user.email, role: user.role ?? 'user' },
  };
}
let settingUp = false;
/** Режим обслуживания на время восстановления из копии: новые подключения не принимаются. */
let maintenance = false;
const MAX_BACKUP_BYTES = Number(process.env.MAX_RESTORE_MB ?? 2048) * 1024 * 1024;
const databaseConfig = z.discriminatedUnion('type', [
  z.object({ type: z.literal('sqlite') }),
  z.object({
    type: z.literal('mariadb'),
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    database: z.string().min(1),
    user: z.string().min(1),
    password: z.string(),
  }),
]);
app.get('/api/health', async () => ({ ok: true }));
app.get('/api/setup', async () => ({
  required: !db || !(await db.selectFrom('users').select('id').executeTakeFirst()),
  registration: db
    ? (
        await db
          .selectFrom('settings')
          .select('value')
          .where('key', '=', 'registration')
          .executeTakeFirst()
      )?.value
    : 'closed',
}));
app.post(
  '/api/setup',
  { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
  async (request, reply) => {
    if (settingUp || (db && (await db.selectFrom('users').select('id').executeTakeFirst())))
      return reply.code(409).send({ message: 'Сервис уже настроен или настройка выполняется' });
    const input = registration
      .extend({
        registration: z.enum(['open', 'closed', 'invite']),
        database: databaseConfig,
      })
      .parse(request.body);
    settingUp = true;
    let conn: DB | undefined;
    try {
      conn = await openDatabase(input.database);
      if (await conn.selectFrom('users').select('id').executeTakeFirst())
        return reply.code(409).send({ message: 'Выбранная база уже настроена' });
      const user = { id: randomUUID(), name: input.name, email: input.email, role: 'admin' };
      const password_hash = await argon2.hash(input.password, { type: argon2.argon2id });
      await conn.transaction().execute(async (trx) => {
        await trx
          .insertInto('users')
          .values({ ...user, password_hash, role: 'admin', created_at: new Date().toISOString() })
          .execute();
        await trx
          .insertInto('settings')
          .values({ key: 'registration', value: input.registration })
          .execute();
      });
      await activateDatabase(conn, input.database);
      conn = undefined;
      return issueSession(user, reply);
    } finally {
      settingUp = false;
      if (conn) await conn.destroy();
    }
  },
);
app.post(
  '/api/auth/register',
  { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
  async (request, reply) => {
    const input = registration.parse(request.body);
    const mode = await database()
      .selectFrom('settings')
      .select('value')
      .where('key', '=', 'registration')
      .executeTakeFirst();
    if (mode?.value !== 'open') return reply.code(403).send({ message: 'Регистрация закрыта' });
    if (
      await database()
        .selectFrom('users')
        .select('id')
        .where('email', '=', input.email)
        .executeTakeFirst()
    )
      return reply.code(409).send({ message: 'Этот адрес уже используется' });
    const user = { id: randomUUID(), email: input.email, name: input.name, role: 'user' };
    await database()
      .insertInto('users')
      .values({
        ...user,
        password_hash: await argon2.hash(input.password, { type: argon2.argon2id }),
        role: 'user',
        created_at: new Date().toISOString(),
      })
      .execute();
    return issueSession(user, reply);
  },
);
// Неудачные входы по аккаунту: работает и за прокси, когда все запросы приходят с одного IP.
const failedLogins = new Map<string, { count: number; until: number }>();
const LOGIN_FAILS = 5;
const LOGIN_LOCK_MS = 15 * 60000;
app.post(
  '/api/auth/login',
  { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
  async (request, reply) => {
    const input = credentials.parse(request.body);
    const now = Date.now();
    const state = failedLogins.get(input.email);
    if (state && state.count >= LOGIN_FAILS && state.until > now)
      return reply
        .code(429)
        .send({ message: 'Слишком много попыток входа. Попробуйте через 15 минут' });
    const user = await database()
      .selectFrom('users')
      .selectAll()
      .where('email', '=', input.email)
      .executeTakeFirst();
    if (!user || !(await argon2.verify(user.password_hash, input.password))) {
      const next = state && state.until > now ? state.count + 1 : 1;
      failedLogins.set(input.email, { count: next, until: now + LOGIN_LOCK_MS });
      if (failedLogins.size > 10000)
        for (const [key, value] of failedLogins) if (value.until <= now) failedLogins.delete(key);
      return reply.code(401).send({ message: 'Неверная почта или пароль' });
    }
    failedLogins.delete(input.email);
    return issueSession(user, reply);
  },
);
app.post('/api/auth/refresh', async (request, reply) => {
  const token = request.cookies.refresh;
  if (!token) return reply.code(401).send({ message: 'Войдите в аккаунт' });
  const session = await database()
    .selectFrom('sessions')
    .selectAll()
    .where('token_hash', '=', hash(token))
    .where('expires_at', '>', new Date().toISOString())
    .executeTakeFirst();
  if (!session) return reply.code(401).send({ message: 'Сессия завершена' });
  const user = await database()
    .selectFrom('users')
    .select(['id', 'name', 'email', 'role'])
    .where('id', '=', session.user_id)
    .executeTakeFirstOrThrow();
  return {
    accessToken: app.jwt.sign({ sub: user.id, sid: session.id }, { expiresIn: '15m' }),
    user,
  };
});
app.post('/api/auth/logout', async (request, reply) => {
  if (request.cookies.refresh)
    await database()
      .deleteFrom('sessions')
      .where('token_hash', '=', hash(request.cookies.refresh))
      .execute();
  reply.clearCookie('refresh', { path: '/api' });
  return { ok: true };
});
app.get('/api/auth/sessions', async (request) => {
  const id = await userId(request);
  const { sid } = request.user as { sid: string };
  const rows = await database()
    .selectFrom('sessions')
    .select(['id', 'created_at', 'expires_at'])
    .where('user_id', '=', id)
    .orderBy('created_at', 'desc')
    .execute();
  return rows.map((row) => ({ ...row, current: row.id === sid }));
});
app.delete('/api/auth/sessions/:id', async (request) => {
  const id = await userId(request);
  await database()
    .deleteFrom('sessions')
    .where('id', '=', (request.params as { id: string }).id)
    .where('user_id', '=', id)
    .execute();
  return { ok: true };
});
// ===== Профиль =====
app.patch('/api/me', async (request) => {
  const id = await userId(request);
  const input = z.object({ name: z.string().trim().min(1).max(120) }).parse(request.body);
  await database().updateTable('users').set({ name: input.name }).where('id', '=', id).execute();
  return database()
    .selectFrom('users')
    .select(['id', 'name', 'email', 'role'])
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
});
app.post(
  '/api/me/password',
  { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
  async (request, reply) => {
    const id = await userId(request);
    const { sid } = request.user as { sid: string };
    const input = z
      .object({ current: z.string().min(1).max(256), next: z.string().min(10).max(256) })
      .parse(request.body);
    const row = await database()
      .selectFrom('users')
      .select('password_hash')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    if (!(await argon2.verify(row.password_hash, input.current)))
      return reply.code(400).send({ message: 'Текущий пароль указан неверно' });
    await database()
      .updateTable('users')
      .set({ password_hash: await argon2.hash(input.next, { type: argon2.argon2id }) })
      .where('id', '=', id)
      .execute();
    // остальные устройства выходят из аккаунта, текущее остаётся
    await database()
      .deleteFrom('sessions')
      .where('user_id', '=', id)
      .where('id', '!=', sid)
      .execute();
    return { ok: true };
  },
);

// ===== Пользователи (администратор) =====
const roleSchema = z.enum(['admin', 'user']);
async function registrationMode() {
  return (
    (
      await database()
        .selectFrom('settings')
        .select('value')
        .where('key', '=', 'registration')
        .executeTakeFirst()
    )?.value ?? 'closed'
  );
}
app.get('/api/admin/users', async (request) => {
  await requireAdmin(request);
  const users = await database()
    .selectFrom('users')
    .select(['id', 'name', 'email', 'role', 'created_at'])
    .orderBy('created_at')
    .execute();
  return { users, registration: await registrationMode() };
});
app.put('/api/admin/registration', async (request) => {
  await requireAdmin(request);
  const { mode } = z.object({ mode: z.enum(['open', 'closed']) }).parse(request.body);
  const exists = await database()
    .selectFrom('settings')
    .select('key')
    .where('key', '=', 'registration')
    .executeTakeFirst();
  if (exists)
    await database()
      .updateTable('settings')
      .set({ value: mode })
      .where('key', '=', 'registration')
      .execute();
  else
    await database().insertInto('settings').values({ key: 'registration', value: mode }).execute();
  return { registration: mode };
});
app.post('/api/admin/users', async (request, reply) => {
  await requireAdmin(request);
  const input = registration.extend({ role: roleSchema.default('user') }).parse(request.body);
  if (
    await database()
      .selectFrom('users')
      .select('id')
      .where('email', '=', input.email)
      .executeTakeFirst()
  )
    return reply.code(409).send({ message: 'Этот адрес уже используется' });
  const user = {
    id: randomUUID(),
    email: input.email,
    name: input.name,
    role: input.role,
    created_at: new Date().toISOString(),
  };
  await database()
    .insertInto('users')
    .values({
      ...user,
      password_hash: await argon2.hash(input.password, { type: argon2.argon2id }),
    })
    .execute();
  return user;
});
app.patch('/api/admin/users/:id', async (request) => {
  const me = await requireAdmin(request);
  const target = (request.params as { id: string }).id;
  const { role, password } = z
    .object({ role: roleSchema.optional(), password: z.string().min(10).max(256).optional() })
    .parse(request.body);
  if (password && target === me)
    throw Object.assign(new Error('Свой пароль меняйте в разделе «Профиль»'), { statusCode: 400 });
  const password_hash = password
    ? await argon2.hash(password, { type: argon2.argon2id })
    : undefined;
  await database()
    .transaction()
    .execute(async (trx) => {
      const user = await trx
        .selectFrom('users')
        .select('role')
        .where('id', '=', target)
        .executeTakeFirst();
      if (!user) throw Object.assign(new Error('Пользователь не найден'), { statusCode: 404 });
      if (role && user.role === 'admin' && role !== 'admin') {
        const admins = await trx
          .selectFrom('users')
          .select(({ fn }) => fn.countAll<number>().as('n'))
          .where('role', '=', 'admin')
          .executeTakeFirstOrThrow();
        if (Number(admins.n) <= 1)
          throw Object.assign(new Error('Нельзя снять права с единственного администратора'), {
            statusCode: 400,
          });
      }
      if (role) await trx.updateTable('users').set({ role }).where('id', '=', target).execute();
      if (password_hash) {
        await trx.updateTable('users').set({ password_hash }).where('id', '=', target).execute();
        // новый пароль выдан администратором — старые входы этого пользователя завершаются
        await trx.deleteFrom('sessions').where('user_id', '=', target).execute();
      }
    });
  return { ok: true };
});
async function authorizeDocument(name: string, owner: string, write = false): Promise<NoteRole> {
  if (name === `space:${owner}`) return 'owner';
  if (!/^note:[0-9a-f-]{36}$/.test(name))
    throw Object.assign(new Error('Нет доступа'), { statusCode: 403 });
  const purged = await database()
    .selectFrom('purged_notes')
    .select('note_id')
    .where('note_id', '=', name.slice(5))
    .executeTakeFirst();
  if (purged) throw Object.assign(new Error('Заметка удалена навсегда'), { statusCode: 410 });
  if (await encryptedRow(name.slice(5)))
    throw Object.assign(new Error('Заметка под паролем'), { statusCode: 409 });
  const row = await database()
    .selectFrom('yjs_documents')
    .select('owner_id')
    .where('name', '=', name)
    .executeTakeFirst();
  if (!row || row.owner_id === owner) return 'owner';
  const member = await database()
    .selectFrom('note_members')
    .selectAll()
    .where('note_id', '=', name.slice(5))
    .where('user_id', '=', owner)
    .where('accepted_at', 'is not', null)
    .executeTakeFirst();
  const meta = member ? await spaceNote(row.owner_id, name.slice(5)) : null;
  if (
    !member ||
    !meta ||
    meta.deletedAt ||
    meta.encrypted ||
    (member.role !== 'editor' && member.role !== 'reader') ||
    (write && member.role !== 'editor')
  )
    throw Object.assign(new Error('Нет доступа'), { statusCode: 403 });
  return member.role as NoteRole;
}
let saving: Promise<unknown> = Promise.resolve();
function serializeDocuments<T>(operation: () => Promise<T>): Promise<T> {
  const next = saving.then(operation);
  saving = next.catch(() => undefined);
  return next;
}
function saveDocument(name: string, document: Y.Doc, owner: string, author = owner) {
  return serializeDocuments(() => storeDocument(name, document, owner, author));
}
async function encryptedRow(noteId: string) {
  return database()
    .selectFrom('encrypted_notes')
    .selectAll()
    .where('note_id', '=', noteId)
    .executeTakeFirst();
}
async function storeDocument(name: string, document: Y.Doc, owner: string, author = owner) {
  if (
    name.startsWith('note:') &&
    ((await database()
      .selectFrom('purged_notes')
      .select('note_id')
      .where('note_id', '=', name.slice(5))
      .executeTakeFirst()) ||
      // заметку только что закрыли паролем — открытый текст больше не сохраняем
      (await encryptedRow(name.slice(5))))
  )
    return;
  await authorizeDocument(name, owner);
  if (name.startsWith('space:')) {
    const tombstones = await database()
      .selectFrom('purged_notes')
      .select('note_id')
      .where('owner_id', '=', owner)
      .execute();
    document.transact(() => {
      for (const row of tombstones)
        if (!document.getMap('purged').has(row.note_id))
          document.getMap('purged').set(row.note_id, true);
      for (const id of expiredNoteIds(document)) document.getMap('purged').set(id, true);
      for (const id of document.getMap('purged').keys()) document.getMap('notes').delete(id);
    });
  }
  const state = Buffer.from(Y.encodeStateAsUpdate(document));
  const now = new Date().toISOString();
  await database()
    .transaction()
    .execute(async (trx) => {
      const existing = await trx
        .selectFrom('yjs_documents')
        .select('owner_id')
        .where('name', '=', name)
        .executeTakeFirst();
      if (existing && existing.owner_id !== owner)
        throw Object.assign(new Error('Нет доступа'), { statusCode: 403 });
      if (existing)
        await trx
          .updateTable('yjs_documents')
          .set({ state, updated_at: now })
          .where('name', '=', name)
          .execute();
      else
        await trx
          .insertInto('yjs_documents')
          .values({ name, owner_id: owner, state, updated_at: now })
          .execute();
      if (name.startsWith('space:')) {
        const purged = document.getMap<boolean>('purged');
        for (const id of purged.keys()) {
          if (!/^[0-9a-f-]{36}$/.test(id)) continue;
          const owned = await trx
            .selectFrom('yjs_documents')
            .select('owner_id')
            .where('name', '=', `note:${id}`)
            .executeTakeFirst();
          const tombstone = await trx
            .selectFrom('purged_notes')
            .selectAll()
            .where('note_id', '=', id)
            .executeTakeFirst();
          if ((owned && owned.owner_id !== owner) || (tombstone && tombstone.owner_id !== owner))
            continue;
          if (!tombstone)
            await trx.insertInto('purged_notes').values({ note_id: id, owner_id: owner }).execute();
          await trx.deleteFrom('yjs_documents').where('name', '=', `note:${id}`).execute();
          await trx.deleteFrom('tasks').where('note_id', '=', id).execute();
          await trx.deleteFrom('note_versions').where('note_id', '=', id).execute();
          await trx.deleteFrom('notes_index').where('note_id', '=', id).execute();
          await trx.deleteFrom('encrypted_notes').where('note_id', '=', id).execute();
          await trx.deleteFrom('shares').where('note_id', '=', id).execute();
          await trx.deleteFrom('note_members').where('note_id', '=', id).execute();
        }
        const deleted = [...deletedNoteIds(document)];
        let restore = trx
          .updateTable('notes_index')
          .set({ deleted: 0, deleted_at: null })
          .where('owner_id', '=', owner);
        if (deleted.length) restore = restore.where('note_id', 'not in', deleted);
        await restore.execute();
        if (deleted.length)
          await trx
            .updateTable('notes_index')
            .set({ deleted: 1 })
            .where('owner_id', '=', owner)
            .where('note_id', 'in', deleted)
            .execute();
        for (const id of deleted) {
          const value = document.getMap('notes').get(id);
          const date =
            value instanceof Y.Map
              ? value.get('deletedAt')
              : (value as { deletedAt?: string })?.deletedAt;
          if (typeof date === 'string')
            await trx
              .updateTable('notes_index')
              .set({ deleted_at: date })
              .where('owner_id', '=', owner)
              .where('note_id', '=', id)
              .execute();
        }
      }
      if (name.startsWith('note:')) {
        const noteId = name.slice(5);
        const extracted = extractDocument(document);
        const tasks = uniqueTasks(extracted.tasks);
        const previous = await trx
          .selectFrom('notes_index')
          .select(['deleted', 'deleted_at'])
          .where('note_id', '=', noteId)
          .executeTakeFirst();
        await trx.deleteFrom('notes_index').where('note_id', '=', noteId).execute();
        await trx
          .insertInto('notes_index')
          .values({
            note_id: noteId,
            owner_id: owner,
            plain_text: extracted.plainText,
            preview: extracted.plainText.slice(0, 180),
            updated_at: now,
            deleted_at: previous?.deleted_at ?? null,
            deleted: previous?.deleted ?? (await isDeleted(trx, owner, noteId)),
          })
          .execute();
        await trx.deleteFrom('tasks').where('note_id', '=', noteId).execute();
        if (tasks.length)
          await trx
            .insertInto('tasks')
            .values(
              tasks.map((t) => ({
                id: t.id,
                note_id: noteId,
                owner_id: owner,
                text: t.text,
                checked: Number(t.checked),
                due: t.due,
                done_at: t.doneAt,
                position: t.position,
              })),
            )
            .execute();
        const last = await trx
          .selectFrom('note_versions')
          .select('created_at')
          .where('note_id', '=', noteId)
          .orderBy('created_at', 'desc')
          .executeTakeFirst();
        if (!last || Date.now() - Date.parse(last.created_at) >= 300000) {
          await trx
            .insertInto('note_versions')
            .values({ id: randomUUID(), note_id: noteId, author, state, created_at: now })
            .execute();
          await pruneVersions(trx, noteId);
        }
      }
    });
}
type Executor = Pick<DB, 'selectFrom' | 'deleteFrom'>;
/** Заметка в корзине по данным документа пространства (для первой записи в notes_index). */
async function isDeleted(trx: Executor, owner: string, noteId: string): Promise<number> {
  const row = await trx
    .selectFrom('yjs_documents')
    .select('state')
    .where('name', '=', `space:${owner}`)
    .executeTakeFirst();
  if (!row) return 0;
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, row.state);
    return deletedNoteIds(doc).has(noteId) ? 1 : 0;
  } finally {
    doc.destroy();
  }
}
/** Прореживание истории: сутки — всё, 30 дней — по одной в день, дальше — по одной в неделю. */
async function pruneVersions(trx: Executor, noteId: string) {
  const versions = await trx
    .selectFrom('note_versions')
    .select(['id', 'created_at'])
    .where('note_id', '=', noteId)
    .execute();
  const keep = versionsToKeep(versions);
  const drop = versions.filter((v) => !keep.has(v.id)).map((v) => v.id);
  if (drop.length) await trx.deleteFrom('note_versions').where('id', 'in', drop).execute();
}
const collab = new Hocuspocus({
  name: 'selfnote',
  debounce: 500,
  maxDebounce: 2000,
  async onAuthenticate({ token, documentName, connectionConfig }) {
    if (maintenance) throw new Error('Идёт восстановление из резервной копии');
    const claims = app.jwt.verify<{ sub: string; sid: string }>(token);
    const session = await database()
      .selectFrom('sessions')
      .select('id')
      .where('id', '=', claims.sid)
      .where('user_id', '=', claims.sub)
      .where('expires_at', '>', new Date().toISOString())
      .executeTakeFirst();
    if (!session) throw new Error('Сессия завершена');
    const role = await authorizeDocument(documentName, claims.sub);
    connectionConfig.readOnly = role === 'reader';
    return { owner: claims.sub, sid: claims.sid };
  },
  async beforeHandleMessage({ context, documentName, connection }) {
    if (maintenance) throw new Error('Идёт восстановление из резервной копии');
    await restoring;
    const role = await authorizeDocument(documentName, (context as { owner: string }).owner);
    connection.readOnly = role === 'reader';
    const { owner, sid } = context as { owner: string; sid: string };
    const session = await database()
      .selectFrom('sessions')
      .select('id')
      .where('id', '=', sid)
      .where('user_id', '=', owner)
      .where('expires_at', '>', new Date().toISOString())
      .executeTakeFirst();
    if (!session) throw new Error('Сессия завершена');
  },
  async onLoadDocument({ documentName, document, context }) {
    const owner = (context as { owner: string }).owner;
    await authorizeDocument(documentName, owner);
    let row = await database()
      .selectFrom('yjs_documents')
      .selectAll()
      .where('name', '=', documentName)
      .executeTakeFirst();
    if (!row) {
      try {
        await database()
          .insertInto('yjs_documents')
          .values({
            name: documentName,
            owner_id: owner,
            state: Buffer.from(Y.encodeStateAsUpdate(document)),
            updated_at: new Date().toISOString(),
          })
          .execute();
      } catch {
        row = await database()
          .selectFrom('yjs_documents')
          .selectAll()
          .where('name', '=', documentName)
          .executeTakeFirstOrThrow();
      }
    }
    if (row) {
      await authorizeDocument(documentName, owner);
      Y.applyUpdate(document, row.state);
    }
    return document;
  },
  async onChange({ documentName, document }) {
    if (documentName.startsWith('space:')) {
      const owner = documentName.slice(6);
      for (const id of new Set([
        ...deletedNoteIds(document),
        ...document.getMap('purged').keys(),
      ])) {
        const row = await database()
          .selectFrom('yjs_documents')
          .select('owner_id')
          .where('name', '=', `note:${id}`)
          .executeTakeFirst();
        if (row?.owner_id === owner) resetNoteConnections(id, undefined, owner);
      }
    }
  },
  async onStoreDocument({ documentName, document, context }) {
    const { owner, historyOperation } = context as { owner: string; historyOperation?: boolean };
    // Владелец документа неизменен; автор правок может быть приглашённым редактором.
    const row = await database()
      .selectFrom('yjs_documents')
      .select('owner_id')
      .where('name', '=', documentName)
      .executeTakeFirst();
    const documentOwner = row?.owner_id ?? owner;
    if (historyOperation) await storeDocument(documentName, document, documentOwner, owner);
    else await saveDocument(documentName, document, documentOwner, owner);
  },
});
app.get('/collab', { websocket: true }, (socket, request) =>
  collab.handleConnection(socket, request.raw),
);
async function accessibleSharedIds(user: string) {
  const members = await database()
    .selectFrom('note_members')
    .select('note_id')
    .where('user_id', '=', user)
    .where('accepted_at', 'is not', null)
    .execute();
  const ids: string[] = [];
  for (const member of members) {
    try {
      await ownedNote(member.note_id, user);
      ids.push(member.note_id);
    } catch {
      /* Доступ отозван или заметка в корзине. */
    }
  }
  return ids;
}
app.get('/api/tasks', async (request) => {
  const owner = await userId(request);
  const shared = await accessibleSharedIds(owner);
  // задачи из заметок в корзине не показываем
  return database()
    .selectFrom('tasks')
    .innerJoin('notes_index', 'notes_index.note_id', 'tasks.note_id')
    .selectAll('tasks')
    .where((eb) =>
      eb.or([
        eb('tasks.owner_id', '=', owner),
        ...(shared.length ? [eb('tasks.note_id', 'in', shared)] : []),
      ]),
    )
    .where('notes_index.deleted', '=', 0)
    .execute();
});
async function ownedNote(id: string, owner: string, write = false) {
  await authorizeDocument(`note:${id}`, owner, write);
  const row = await database()
    .selectFrom('yjs_documents')
    .select('name')
    .where('name', '=', `note:${id}`)
    .executeTakeFirst();
  if (!row) throw Object.assign(new Error('Заметка не найдена'), { statusCode: 404 });
}
app.get('/api/notes/:id/versions', async (request) => {
  const owner = await userId(request);
  const id = z.uuid().parse((request.params as { id: string }).id);
  await ownedNote(id, owner);
  return database()
    .selectFrom('note_versions')
    .leftJoin('users', 'users.id', 'note_versions.author')
    .select([
      'note_versions.id',
      'note_versions.created_at',
      'note_versions.label',
      'note_versions.author',
      'users.name as author_name',
    ])
    .where('note_id', '=', id)
    .orderBy('note_versions.created_at', 'desc')
    .execute();
});
app.get('/api/notes/:id/versions/:vid', async (request) => {
  const owner = await userId(request);
  const { id, vid } = z.object({ id: z.uuid(), vid: z.uuid() }).parse(request.params);
  await ownedNote(id, owner);
  const row = await database()
    .selectFrom('note_versions')
    .selectAll()
    .where('note_id', '=', id)
    .where('id', '=', vid)
    .executeTakeFirst();
  if (!row) throw Object.assign(new Error('Версия не найдена'), { statusCode: 404 });
  return { ...row, state: row.state.toString('base64') };
});
let restoring: Promise<unknown> = Promise.resolve();
app.post('/api/notes/:id/versions/:vid/restore', async (request) => {
  const owner = await userId(request);
  const { id, vid } = z.object({ id: z.uuid(), vid: z.uuid() }).parse(request.params);
  const work = serializeDocuments(async () => {
    await ownedNote(id, owner, true);
    const version = await database()
      .selectFrom('note_versions')
      .select('state')
      .where('note_id', '=', id)
      .where('id', '=', vid)
      .executeTakeFirst();
    if (!version) throw Object.assign(new Error('Версия не найдена'), { statusCode: 404 });
    const connection = await collab.openDirectConnection(`note:${id}`, {
      owner,
      historyOperation: true,
    });
    try {
      const doc = connection.document!;
      // Сохраняем живое состояние до изменения, включая правки других вкладок.
      await database()
        .insertInto('note_versions')
        .values({
          id: randomUUID(),
          note_id: id,
          author: owner,
          state: Buffer.from(Y.encodeStateAsUpdate(doc)),
          created_at: new Date().toISOString(),
          label: 'До восстановления',
        })
        .execute();
      let restored!: Buffer;
      await connection.transact((document) => {
        restoreContent(document, version.state);
        restored = Buffer.from(Y.encodeStateAsUpdate(document));
      });
      await database()
        .insertInto('note_versions')
        .values({
          id: randomUUID(),
          note_id: id,
          author: owner,
          state: restored,
          created_at: new Date().toISOString(),
          label: 'Восстановленная версия',
        })
        .execute();
    } finally {
      await connection.disconnect();
    }
    return { ok: true };
  });
  restoring = work.catch(() => undefined);
  return work;
});
app.post('/api/notes/:id/versions', { bodyLimit: 24 * 1024 * 1024 }, async (request, reply) => {
  const owner = await userId(request);
  const id = z.uuid().parse((request.params as { id: string }).id);
  const { state } = z.object({ state: z.string().max(20 * 1024 * 1024) }).parse(request.body);
  return serializeDocuments(async () => {
    await authorizeDocument(`note:${id}`, owner, true);
    const row = await database()
      .selectFrom('yjs_documents')
      .select('owner_id')
      .where('name', '=', `note:${id}`)
      .executeTakeFirst();
    if (!row) return reply.code(409).send({ message: 'Дождитесь синхронизации заметки' });
    const bytes = Buffer.from(state, 'base64');
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, bytes);
    } finally {
      doc.destroy();
    }
    await database()
      .insertInto('note_versions')
      .values({
        id: randomUUID(),
        note_id: id,
        author: owner,
        state: bytes,
        created_at: new Date().toISOString(),
      })
      .execute();
    await pruneVersions(database(), id);
    return { ok: true };
  });
});
app.post('/api/attachments', async (request, reply) => {
  const actor = await userId(request);
  let owner = actor;
  const { noteId } = z.object({ noteId: z.uuid().optional() }).parse(request.query);
  if (noteId) {
    await ownedNote(noteId, actor, true);
    const row = await database()
      .selectFrom('yjs_documents')
      .select('owner_id')
      .where('name', '=', `note:${noteId}`)
      .executeTakeFirstOrThrow();
    owner = row.owner_id;
  }
  const file = await request.file();
  if (!file) return reply.code(400).send({ message: 'Выберите изображение' });
  const input = await file.toBuffer();
  let output: Buffer;
  try {
    output = await sharp(input, { limitInputPixels: 40000000 })
      .rotate()
      .resize({ width: 2560, height: 2560, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 88 })
      .toBuffer();
  } catch {
    return reply.code(400).send({ message: 'Не удалось прочитать изображение' });
  }
  const id = createHash('sha256').update(output).digest('hex');
  const directory = path.join(dataDir, 'attachments', owner);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `${id}.webp`), output);
  await sharp(output)
    .resize({ width: 480, withoutEnlargement: true })
    .toFile(path.join(directory, `${id}.preview.webp`));
  if (
    !(await database()
      .selectFrom('attachments')
      .select('id')
      .where('id', '=', id)
      .where('owner_id', '=', owner)
      .executeTakeFirst())
  )
    await database()
      .insertInto('attachments')
      .values({
        id,
        owner_id: owner,
        filename: `${id}.webp`,
        mime: 'image/webp',
        created_at: new Date().toISOString(),
      })
      .execute();
  return { id, url: `/api/attachments/${id}`, preview: `/api/attachments/${id}?preview=1` };
});
app.get('/api/attachments/:id', async (request, reply) => {
  let owner: string;
  try {
    owner = await userId(request);
  } catch {
    const token = request.cookies.refresh;
    if (!token) return reply.code(401).send();
    const session = await database()
      .selectFrom('sessions')
      .select('user_id')
      .where('token_hash', '=', hash(token))
      .where('expires_at', '>', new Date().toISOString())
      .executeTakeFirst();
    if (!session) return reply.code(401).send();
    owner = session.user_id;
  }
  const id = z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .parse((request.params as { id: string }).id);
  let row = await database()
    .selectFrom('attachments')
    .select('id')
    .where('id', '=', id)
    .where('owner_id', '=', owner)
    .executeTakeFirst();
  if (!row) {
    const memberships = await database()
      .selectFrom('note_members')
      .select('note_id')
      .where('user_id', '=', owner)
      .where('accepted_at', 'is not', null)
      .execute();
    for (const member of memberships) {
      try {
        await ownedNote(member.note_id, owner);
      } catch {
        continue;
      }
      const source = await database()
        .selectFrom('yjs_documents')
        .select('owner_id')
        .where('name', '=', `note:${member.note_id}`)
        .executeTakeFirst();
      if (!source) continue;
      const content = await noteDocument(member.note_id);
      let referenced = false;
      if (content) {
        try {
          referenced = renderDocument(content.doc.getXmlFragment('content')).images.includes(
            `/api/attachments/${id}`,
          );
        } finally {
          content.release();
        }
      }
      if (!referenced) {
        const versions = await database()
          .selectFrom('note_versions')
          .select('state')
          .where('note_id', '=', member.note_id)
          .execute();
        for (const version of versions) {
          const doc = new Y.Doc();
          try {
            Y.applyUpdate(doc, version.state);
            referenced = renderDocument(doc.getXmlFragment('content')).images.includes(
              `/api/attachments/${id}`,
            );
          } finally {
            doc.destroy();
          }
          if (referenced) break;
        }
      }
      if (!referenced) continue;
      row = await database()
        .selectFrom('attachments')
        .select('id')
        .where('id', '=', id)
        .where('owner_id', '=', source.owner_id)
        .executeTakeFirst();
      if (row) {
        owner = source.owner_id;
        break;
      }
    }
  }
  if (!row) return reply.code(404).send();
  const preview = (request.query as { preview?: string }).preview === '1';
  reply.header('Cache-Control', 'private, no-store');
  return reply
    .type('image/webp')
    .send(
      await readFile(
        path.join(dataDir, 'attachments', owner, `${id}${preview ? '.preview' : ''}.webp`),
      ),
    );
});
/** Ежедневная страховка для устройств, которые давно не запускались. */
async function cleanTrash() {
  if (!db) return;
  const spaces = await database()
    .selectFrom('yjs_documents')
    .select(['name', 'owner_id'])
    .where('name', 'like', 'space:%')
    .execute();
  for (const row of spaces) {
    const connection = await collab.openDirectConnection(row.name, { owner: row.owner_id });
    try {
      await connection.transact((doc) => {
        doc.transact(() => {
          for (const id of expiredNoteIds(doc)) {
            doc.getMap('purged').set(id, true);
            doc.getMap('notes').delete(id);
          }
          for (const id of doc.getMap('purged').keys()) doc.getMap('notes').delete(id);
        });
      });
    } finally {
      await connection.disconnect();
    }
  }
  // Версии тоже удерживают картинки. Свежие загрузки оставляем для офлайн-очереди.
  const used = new Set<string>();
  const states = [
    ...(await database().selectFrom('yjs_documents').select(['owner_id', 'state']).execute()),
    ...(await database()
      .selectFrom('note_versions')
      .innerJoin('notes_index', 'notes_index.note_id', 'note_versions.note_id')
      .select(['notes_index.owner_id', 'note_versions.state'])
      .execute()),
  ];
  const collect = (doc: Y.Doc, owner: string) => {
    const walk = (node: Y.XmlFragment | Y.XmlElement) => {
      for (const child of node.toArray())
        if (child instanceof Y.XmlElement) {
          const src = child.getAttribute('src');
          if (child.nodeName === 'image' && src?.startsWith('/api/attachments/'))
            used.add(`${owner}:${src.split('/')[3]}`);
          walk(child);
        }
    };
    walk(doc.getXmlFragment('content'));
  };
  for (const row of states) {
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, row.state);
      collect(doc, row.owner_id);
    } finally {
      doc.destroy();
    }
  }
  for (const [name, doc] of collab.documents) {
    if (!name.startsWith('note:')) continue;
    const row = await database()
      .selectFrom('yjs_documents')
      .select('owner_id')
      .where('name', '=', name)
      .executeTakeFirst();
    if (row) collect(doc, row.owner_id);
  }
  // картинки заметок под паролем: сервер не видит содержимое, список присылает клиент
  for (const row of await database()
    .selectFrom('encrypted_notes')
    .select(['owner_id', 'attachments'])
    .execute())
    for (const id of JSON.parse(row.attachments || '[]') as string[])
      used.add(`${row.owner_id}:${id}`);
  const attachments = await database()
    .selectFrom('attachments')
    .selectAll()
    .where('created_at', '<', new Date(Date.now() - 30 * 86400000).toISOString())
    .execute();
  for (const file of attachments)
    if (!used.has(`${file.owner_id}:${file.id}`)) {
      await rm(path.join(dataDir, 'attachments', file.owner_id, file.filename), { force: true });
      await rm(path.join(dataDir, 'attachments', file.owner_id, `${file.id}.preview.webp`), {
        force: true,
      });
      await database()
        .deleteFrom('attachments')
        .where('id', '=', file.id)
        .where('owner_id', '=', file.owner_id)
        .execute();
    }
}
let cleaning = false;
async function runCleanup() {
  if (cleaning) return;
  cleaning = true;
  try {
    await cleanTrash();
  } catch (error) {
    app.log.error(error, 'Не удалось очистить корзину');
  } finally {
    cleaning = false;
  }
}
const cleanupTimer = setInterval(() => void runCleanup(), 86400000);
cleanupTimer.unref();

// ===== Серверный поиск =====
app.get('/api/search', async (request) => {
  const owner = await userId(request);
  const { q } = z.object({ q: z.string().max(200) }).parse(request.query);
  const shared = await accessibleSharedIds(owner);
  const terms = searchTerms(q);
  if (!terms.length) return [];
  let rows: { note_id: string; plain_text: string }[];
  if (dbType === 'mariadb') {
    // FULLTEXT не индексирует слова короче 3 букв — их ищем через LIKE
    const long = terms.filter((t) => t.length >= 3);
    const short = terms.filter((t) => t.length < 3);
    let query = database()
      .selectFrom('notes_index')
      .select(['note_id', 'plain_text'])
      .where((eb) =>
        eb.or([
          eb('owner_id', '=', owner),
          ...(shared.length ? [eb('note_id', 'in', shared)] : []),
        ]),
      )
      .where('deleted', '=', 0);
    if (long.length)
      query = query.where(
        sql<SqlBool>`MATCH(plain_text) AGAINST(${long.map((t) => `+${t}*`).join(' ')} IN BOOLEAN MODE)`,
      );
    for (const term of short) query = query.where('plain_text', 'like', `%${term}%`);
    rows = await query.orderBy('updated_at', 'desc').limit(50).execute();
  } else {
    const match = terms.map((t) => `"${t}"*`).join(' ');
    rows = (
      await sql<{ note_id: string; plain_text: string }>`
        SELECT n.note_id, n.plain_text FROM notes_fts
        JOIN notes_index n ON n.rowid = notes_fts.rowid
        WHERE notes_fts MATCH ${match} AND (n.owner_id = ${owner} ${shared.length ? sql`OR n.note_id IN (${sql.join(shared)})` : sql``}) AND n.deleted = 0
        ORDER BY rank LIMIT 50`.execute(database())
    ).rows;
  }
  return rows.map((row) => ({ id: row.note_id, parts: snippet(row.plain_text, q) }));
});

// ===== Заметки под паролем =====
// Сервер хранит непрозрачный зашифрованный снапшот с номером версии. Запись — только
// поверх известной клиенту версии; иначе 409 с актуальной копией (клиент сливает правки).
app.get('/api/encrypted', async (request) => {
  const owner = await userId(request);
  return database()
    .selectFrom('encrypted_notes')
    .select(['note_id', 'version', 'updated_at'])
    .where('owner_id', '=', owner)
    .execute();
});
app.get('/api/encrypted/:id', async (request, reply) => {
  const owner = await userId(request);
  const id = z.uuid().parse((request.params as { id: string }).id);
  const row = await encryptedRow(id);
  if (!row || row.owner_id !== owner)
    return reply.code(404).send({ message: 'Заметка не найдена' });
  return {
    note_id: row.note_id,
    version: row.version,
    payload: row.payload,
    updated_at: row.updated_at,
  };
});
const encryptedInput = z.object({
  version: z.number().int().min(0),
  payload: z
    .string()
    .min(10)
    .max(30 * 1024 * 1024),
  attachments: z
    .array(z.string().regex(/^[a-f0-9]{64}$/))
    .max(5000)
    .default([]),
});
app.put('/api/encrypted/:id', { bodyLimit: 32 * 1024 * 1024 }, async (request, reply) => {
  const owner = await userId(request);
  const id = z.uuid().parse((request.params as { id: string }).id);
  const input = encryptedInput.parse(request.body);
  try {
    const envelope = JSON.parse(input.payload);
    if (envelope?.v !== 1 || typeof envelope.data !== 'string') throw new Error();
  } catch {
    return reply.code(400).send({ message: 'Ожидаются зашифрованные данные' });
  }
  return serializeDocuments(async () => {
    if (
      await database()
        .selectFrom('purged_notes')
        .select('note_id')
        .where('note_id', '=', id)
        .executeTakeFirst()
    )
      return reply.code(410).send({ message: 'Заметка удалена навсегда' });
    const now = new Date().toISOString();
    const members = await database()
      .selectFrom('note_members')
      .select('user_id')
      .where('note_id', '=', id)
      .executeTakeFirst();
    if (members)
      return reply.code(409).send({ message: 'Сначала отзовите совместный доступ и приглашения' });
    const attachments = JSON.stringify(input.attachments);
    const row = await encryptedRow(id);
    if (row && row.owner_id !== owner) return reply.code(403).send({ message: 'Нет доступа' });
    if (!row) {
      if (input.version !== 0)
        return reply.code(409).send({ message: 'С заметки сняли пароль', version: 0 });
      const plain = await database()
        .selectFrom('yjs_documents')
        .select('owner_id')
        .where('name', '=', `note:${id}`)
        .executeTakeFirst();
      if (plain && plain.owner_id !== owner)
        return reply.code(403).send({ message: 'Нет доступа' });
      // Закрываем паролем: открытый текст, задачи и история версий удаляются с сервера.
      await database()
        .transaction()
        .execute(async (trx) => {
          await trx
            .insertInto('encrypted_notes')
            .values({
              note_id: id,
              owner_id: owner,
              version: 1,
              payload: input.payload,
              attachments,
              updated_at: now,
            })
            .execute();
          await trx.deleteFrom('yjs_documents').where('name', '=', `note:${id}`).execute();
          await trx.deleteFrom('notes_index').where('note_id', '=', id).execute();
          await trx.deleteFrom('tasks').where('note_id', '=', id).execute();
          await trx.deleteFrom('note_versions').where('note_id', '=', id).execute();
          await trx.deleteFrom('shares').where('note_id', '=', id).execute();
          await trx.deleteFrom('note_members').where('note_id', '=', id).execute();
        });
      collab.closeConnections(`note:${id}`);
      return { version: 1, updated_at: now };
    }
    if (row.version !== input.version)
      return reply.code(409).send({
        message: 'Заметку изменили на другом устройстве',
        version: row.version,
        payload: row.payload,
      });
    await database()
      .updateTable('encrypted_notes')
      .set({ version: row.version + 1, payload: input.payload, attachments, updated_at: now })
      .where('note_id', '=', id)
      .execute();
    return { version: row.version + 1, updated_at: now };
  });
});
/** Снять пароль: клиент затем отправит открытый документ по WebSocket. */
app.delete('/api/encrypted/:id', async (request, reply) => {
  const owner = await userId(request);
  const id = z.uuid().parse((request.params as { id: string }).id);
  return serializeDocuments(async () => {
    const row = await encryptedRow(id);
    if (!row || row.owner_id !== owner)
      return reply.code(404).send({ message: 'Заметка не найдена' });
    await database()
      .transaction()
      .execute(async (trx) => {
        await trx.deleteFrom('encrypted_notes').where('note_id', '=', id).execute();
        await trx.deleteFrom('shares').where('note_id', '=', id).execute();
        await trx.deleteFrom('note_members').where('note_id', '=', id).execute();
      });
    return { ok: true };
  });
});

// ===== Совместный доступ зарегистрированных пользователей =====
/** Закрываем транспорт участника: провайдер сам повторит вход и получит новую роль. */
function resetNoteConnections(id: string, userId?: string, except?: string) {
  const document = collab.documents.get(`note:${id}`);
  if (!document) return;
  for (const { connection } of document.connections.values()) {
    const actor = (connection.context as { owner: string }).owner;
    if ((!userId || actor === userId) && actor !== except)
      connection.webSocket.close(4205, 'Права доступа изменились');
  }
}
async function manageNote(id: string, user: string) {
  if ((await ownedNoteKind(id, user)) !== 'plain')
    throw Object.assign(new Error('Только владелец обычной заметки может управлять доступом'), {
      statusCode: 403,
    });
  const meta = await spaceNote(user, id);
  if (!meta || meta.deletedAt || meta.encrypted)
    throw Object.assign(new Error('Заметка недоступна'), { statusCode: 409 });
  return meta;
}
app.get('/api/collaboration', async (request): Promise<CollaborationList> => {
  const user = await userId(request);
  const rows = await database()
    .selectFrom('note_members')
    .innerJoin('yjs_documents', (join) =>
      join.on(
        'yjs_documents.name',
        '=',
        dbType === 'sqlite'
          ? sql<string>`'note:' || note_members.note_id`
          : sql<string>`concat('note:', note_members.note_id)`,
      ),
    )
    .innerJoin('users', 'users.id', 'yjs_documents.owner_id')
    .select([
      'note_members.note_id',
      'note_members.role',
      'note_members.accepted_at',
      'users.name as owner_name',
      'yjs_documents.owner_id',
    ])
    .where('note_members.user_id', '=', user)
    .execute();
  const notes: CollaborationList['notes'] = [];
  for (const row of rows) {
    const meta = await spaceNote(row.owner_id, row.note_id);
    if (!meta || meta.deletedAt || meta.encrypted || (await encryptedRow(row.note_id))) continue;
    notes.push({
      note: {
        ...meta,
        notebookId: null,
        sectionId: null,
        tags: [],
        pinned: false,
        favorite: false,
      },
      role: row.role as 'editor' | 'reader',
      ownerName: row.owner_name,
      pending: !row.accepted_at,
    });
  }
  const ownedRows = await database()
    .selectFrom('note_members')
    .innerJoin('notes_index', 'notes_index.note_id', 'note_members.note_id')
    .select('note_members.note_id')
    .where('notes_index.owner_id', '=', user)
    .distinct()
    .execute();
  return { notes, owned: ownedRows.map((row) => row.note_id) };
});
app.get('/api/notes/:id/members', async (request) => {
  const user = await userId(request);
  const id = z.uuid().parse((request.params as { id: string }).id);
  await manageNote(id, user);
  return database()
    .selectFrom('note_members')
    .innerJoin('users', 'users.id', 'note_members.user_id')
    .select([
      'users.id',
      'users.name',
      'users.email',
      'note_members.role',
      'note_members.accepted_at',
    ])
    .where('note_members.note_id', '=', id)
    .orderBy('note_members.created_at')
    .execute();
});
app.post(
  '/api/notes/:id/members',
  { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
  async (request) => {
    const user = await userId(request);
    const id = z.uuid().parse((request.params as { id: string }).id);
    const input = z
      .object({
        email: z.email().transform((v) => v.toLowerCase()),
        role: z.enum(['editor', 'reader']),
      })
      .parse(request.body);
    return serializeDocuments(async () => {
      const meta = await manageNote(id, user);
      const target = await database()
        .selectFrom('users')
        .select('id')
        .where('email', '=', input.email)
        .executeTakeFirst();
      if (!target)
        throw Object.assign(new Error('Пользователь с таким адресом не найден'), {
          statusCode: 404,
        });
      if (target.id === user)
        throw Object.assign(new Error('Вы уже владелец этой заметки'), { statusCode: 400 });
      const exists = await database()
        .selectFrom('note_members')
        .select('user_id')
        .where('note_id', '=', id)
        .where('user_id', '=', target.id)
        .executeTakeFirst();
      if (exists) throw Object.assign(new Error('Пользователь уже приглашён'), { statusCode: 409 });
      // Общий заголовок хранится в документе заметки, чужое пространство не раскрывается.
      const connection = await collab.openDirectConnection(`note:${id}`, {
        owner: user,
        historyOperation: true,
      });
      try {
        await connection.transact((doc) => {
          const fields = doc.getMap('collaboration');
          if (!fields.has('title')) fields.set('title', meta.title);
          if (!fields.has('updatedAt')) fields.set('updatedAt', meta.updatedAt);
        });
      } finally {
        await connection.disconnect();
      }
      await database()
        .insertInto('note_members')
        .values({
          note_id: id,
          user_id: target.id,
          role: input.role,
          accepted_at: null,
          created_at: new Date().toISOString(),
        })
        .execute();
      return { ok: true };
    });
  },
);
app.patch('/api/notes/:id/members/:uid', async (request) => {
  const user = await userId(request);
  const { id, uid } = z.object({ id: z.uuid(), uid: z.uuid() }).parse(request.params);
  const { role } = z.object({ role: z.enum(['editor', 'reader']) }).parse(request.body);
  return serializeDocuments(async () => {
    await manageNote(id, user);
    await database()
      .updateTable('note_members')
      .set({ role })
      .where('note_id', '=', id)
      .where('user_id', '=', uid)
      .execute();
    resetNoteConnections(id, uid);
    return { ok: true };
  });
});
app.post('/api/notes/:id/membership/accept', async (request) => {
  const user = await userId(request);
  const id = z.uuid().parse((request.params as { id: string }).id);
  return serializeDocuments(async () => {
    const doc = await database()
      .selectFrom('yjs_documents')
      .select('owner_id')
      .where('name', '=', `note:${id}`)
      .executeTakeFirst();
    if (!doc) throw Object.assign(new Error('Приглашение недоступно'), { statusCode: 404 });
    await manageNote(id, doc.owner_id);
    const result = await database()
      .updateTable('note_members')
      .set({ accepted_at: new Date().toISOString() })
      .where('note_id', '=', id)
      .where('user_id', '=', user)
      .executeTakeFirst();
    if (!Number(result.numUpdatedRows))
      throw Object.assign(new Error('Приглашение отозвано'), { statusCode: 404 });
    return { ok: true };
  });
});
app.delete('/api/notes/:id/members/:uid', async (request) => {
  const user = await userId(request);
  const { id, uid } = z.object({ id: z.uuid(), uid: z.uuid() }).parse(request.params);
  return serializeDocuments(async () => {
    if (uid !== user) await manageNote(id, user);
    await database()
      .deleteFrom('note_members')
      .where('note_id', '=', id)
      .where('user_id', '=', uid)
      .execute();
    resetNoteConnections(id, uid);
    return { ok: true };
  });
});

// ===== Публичные ссылки =====
/** Метаданные заметки из документа пространства владельца (название, корзина). */
async function spaceNote(owner: string, noteId: string): Promise<Note | null> {
  let doc = collab.documents.get(`space:${owner}`) as Y.Doc | undefined;
  let temporary: Y.Doc | undefined;
  if (!doc) {
    const row = await database()
      .selectFrom('yjs_documents')
      .select('state')
      .where('name', '=', `space:${owner}`)
      .executeTakeFirst();
    if (!row) return null;
    temporary = doc = new Y.Doc();
    Y.applyUpdate(doc, row.state);
  }
  try {
    const value = doc.getMap<unknown>('notes').get(noteId);
    if (!value) return null;
    const meta = (value instanceof Y.Map ? value.toJSON() : value) as Note;
    const content = await noteDocument(noteId);
    if (!content) return meta;
    try {
      const fields = content.doc.getMap('collaboration');
      const title = fields.get('title'),
        updatedAt = fields.get('updatedAt');
      return {
        ...meta,
        ...(typeof title === 'string' ? { title } : {}),
        ...(typeof updatedAt === 'string' && Number.isFinite(Date.parse(updatedAt))
          ? { updatedAt }
          : {}),
      };
    } finally {
      content.release();
    }
  } finally {
    temporary?.destroy();
  }
}
/** Документ заметки: живой (если открыт кем-то) или сохранённый. */
async function noteDocument(noteId: string): Promise<{ doc: Y.Doc; release: () => void } | null> {
  const live = collab.documents.get(`note:${noteId}`) as Y.Doc | undefined;
  if (live) return { doc: live, release: () => undefined };
  const row = await database()
    .selectFrom('yjs_documents')
    .select('state')
    .where('name', '=', `note:${noteId}`)
    .executeTakeFirst();
  if (!row) return null;
  const doc = new Y.Doc();
  Y.applyUpdate(doc, row.state);
  return { doc, release: () => doc.destroy() };
}
async function ownedNoteKind(id: string, owner: string): Promise<'plain' | 'encrypted' | null> {
  const encrypted = await encryptedRow(id);
  if (encrypted) return encrypted.owner_id === owner ? 'encrypted' : null;
  const row = await database()
    .selectFrom('yjs_documents')
    .select('owner_id')
    .where('name', '=', `note:${id}`)
    .executeTakeFirst();
  return row?.owner_id === owner ? 'plain' : null;
}
const shareColumns = [
  'id',
  'token',
  'note_id',
  'expires_at',
  'encrypted',
  'views',
  'created_at',
  'password_hash',
] as const;
type ShareRow = { password_hash: string | null } & Record<string, unknown>;
const publicShare = ({ password_hash, ...rest }: ShareRow) => ({
  ...rest,
  has_password: Boolean(password_hash),
});
app.get('/api/shares', async (request) => {
  const owner = await userId(request);
  const rows = await database()
    .selectFrom('shares')
    .select(shareColumns)
    .where('owner_id', '=', owner)
    .orderBy('created_at', 'desc')
    .execute();
  return rows.map(publicShare);
});
app.get('/api/notes/:id/shares', async (request) => {
  const owner = await userId(request);
  const id = z.uuid().parse((request.params as { id: string }).id);
  const rows = await database()
    .selectFrom('shares')
    .select(shareColumns)
    .where('owner_id', '=', owner)
    .where('note_id', '=', id)
    .orderBy('created_at', 'desc')
    .execute();
  return rows.map(publicShare);
});
app.post('/api/notes/:id/shares', async (request, reply) => {
  const owner = await userId(request);
  const id = z.uuid().parse((request.params as { id: string }).id);
  const input = z
    .object({
      password: z.string().min(4).max(128).nullish(),
      expiresAt: z.iso.datetime({ offset: true }).nullish(),
    })
    .parse(request.body);
  const kind = await ownedNoteKind(id, owner);
  if (!kind) return reply.code(404).send({ message: 'Дождитесь синхронизации заметки с сервером' });
  if (input.expiresAt && Date.parse(input.expiresAt) <= Date.now())
    return reply.code(400).send({ message: 'Срок действия должен быть в будущем' });
  const row = {
    id: randomUUID(),
    token: randomBytes(32).toString('base64url'),
    note_id: id,
    owner_id: owner,
    password_hash: input.password
      ? await argon2.hash(input.password, { type: argon2.argon2id })
      : null,
    expires_at: input.expiresAt ? new Date(input.expiresAt).toISOString() : null,
    encrypted: kind === 'encrypted' ? 1 : 0,
    created_at: new Date().toISOString(),
  };
  await database().insertInto('shares').values(row).execute();
  return publicShare({ ...row, views: 0 });
});
app.delete('/api/shares/:id', async (request) => {
  const owner = await userId(request);
  const id = z.uuid().parse((request.params as { id: string }).id);
  await database()
    .deleteFrom('shares')
    .where('id', '=', id)
    .where('owner_id', '=', owner)
    .execute();
  return { ok: true };
});

type Share = NonNullable<Awaited<ReturnType<typeof findShare>>>;
async function findShare(token: string) {
  if (!db || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const share = await database()
    .selectFrom('shares')
    .selectAll()
    .where('token', '=', token)
    .executeTakeFirst();
  if (!share || (share.expires_at && Date.parse(share.expires_at) <= Date.now())) return null;
  const meta = await spaceNote(share.owner_id, share.note_id);
  if (!meta || meta.deletedAt) return null;
  const encrypted = await encryptedRow(share.note_id);
  // заметку закрыли паролем или сняли пароль после создания ссылки — ссылка устарела
  if (Boolean(encrypted) !== Boolean(share.encrypted)) return null;
  return { share, meta, encrypted };
}
const shareCookie = (share: { id: string }) => `share_${share.id.replace(/-/g, '')}`;
function shareUnlocked(request: import('fastify').FastifyRequest, share: Share['share']) {
  if (!share.password_hash) return true;
  const value = request.cookies[shareCookie(share)];
  if (!value) return false;
  try {
    return app.jwt.verify<{ share?: string }>(value).share === share.id;
  } catch {
    return false;
  }
}
const shareFails = new Map<string, { count: number; until: number }>();
function sendPage(reply: import('fastify').FastifyReply, html: string, status = 200) {
  return reply
    .code(status)
    .header('Content-Type', 'text/html; charset=utf-8')
    .header('Content-Security-Policy', SHARE_CSP)
    .header('X-Robots-Tag', 'noindex, nofollow')
    .header('Referrer-Policy', 'no-referrer')
    .header('X-Content-Type-Options', 'nosniff')
    .header('Cache-Control', 'no-store')
    .send(html);
}
const origin = (request: import('fastify').FastifyRequest) =>
  process.env.APP_ORIGIN || `${request.protocol}://${request.host}`;
app.get('/s/:token', async (request, reply) => {
  const token = (request.params as { token: string }).token;
  const assets = await shareAssets(webRoot);
  const found = await findShare(token);
  if (!found) return sendPage(reply, unavailablePage(assets), 404);
  const { share, meta } = found;
  const locked = !shareUnlocked(request, share);
  const error = (request.query as { error?: string }).error ? 'Неверный пароль' : undefined;
  const url = `${origin(request)}/s/${token}`;
  if (share.encrypted || locked) {
    // содержимое не раскрываем в превью: ни для пароля ссылки, ни для шифрованной заметки
    if (!locked)
      await database()
        .updateTable('shares')
        .set({ views: sql`views + 1` })
        .where('id', '=', share.id)
        .execute();
    return sendPage(
      reply,
      sharePage({
        token,
        title: share.encrypted ? 'Заметка под паролем' : meta.title || 'Заметка',
        description: 'Заметка защищена паролем',
        url,
        body: share.encrypted ? '<p class="share-status">Расшифровываем заметку…</p>' : '',
        encrypted: Boolean(share.encrypted),
        locked,
        error,
        updatedAt: meta.updatedAt,
        assets,
      }),
    );
  }
  const note = await noteDocument(share.note_id);
  if (!note) return sendPage(reply, unavailablePage(assets), 404);
  try {
    const rendered = renderDocument(note.doc.getXmlFragment('content'), {
      today: localDate(),
      image: (src) =>
        src.startsWith('/api/attachments/') ? `/s/${token}/img/${src.split('/')[3]}` : null,
    });
    const firstImage = rendered.images.find((src) => src.startsWith('/api/attachments/'));
    await database()
      .updateTable('shares')
      .set({ views: sql`views + 1` })
      .where('id', '=', share.id)
      .execute();
    return sendPage(
      reply,
      sharePage({
        token,
        title: meta.title || 'Без названия',
        description: rendered.text.replace(/\s+/g, ' ').slice(0, 200) || 'Заметка в SelfNote',
        image: firstImage ? `${origin(request)}/s/${token}/img/${firstImage.split('/')[3]}` : null,
        url,
        updatedAt: meta.updatedAt,
        body: rendered.html || '<p class="share-status">Заметка пока пустая.</p>',
        encrypted: false,
        locked: false,
        assets,
      }),
    );
  } finally {
    note.release();
  }
});
app.post(
  '/s/:token/unlock',
  { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
  async (request, reply) => {
    const token = (request.params as { token: string }).token;
    const json = !String(request.headers['content-type'] ?? '').includes('urlencoded');
    const found = await findShare(token);
    if (!found)
      return json
        ? reply.code(404).send({ message: 'Ссылка недоступна' })
        : reply.redirect(`/s/${token}`, 303);
    const { share } = found;
    const { password } = z
      .object({ password: z.string().max(256).default('') })
      .parse(request.body ?? {});
    const now = Date.now();
    const state = shareFails.get(share.id);
    if (state && state.count >= 10 && state.until > now)
      return json
        ? reply.code(429).send({ message: 'Слишком много попыток. Попробуйте через 15 минут' })
        : sendPage(
            reply,
            unavailablePage(await shareAssets(webRoot), 'Слишком много попыток'),
            429,
          );
    if (share.password_hash && !(await argon2.verify(share.password_hash, password))) {
      shareFails.set(share.id, {
        count: state && state.until > now ? state.count + 1 : 1,
        until: now + 15 * 60000,
      });
      return json
        ? reply.code(401).send({ message: 'Неверный пароль' })
        : reply.redirect(`/s/${token}?error=1`, 303);
    }
    shareFails.delete(share.id);
    if (share.password_hash)
      reply.setCookie(shareCookie(share), app.jwt.sign({ share: share.id }, { expiresIn: '12h' }), {
        httpOnly: true,
        secure,
        sameSite: 'lax',
        path: `/s/${token}`,
        maxAge: 12 * 3600,
      });
    return json ? { ok: true } : reply.redirect(`/s/${token}`, 303);
  },
);
/** Зашифрованное содержимое для страницы ссылки — расшифровывает браузер ключом из #фрагмента. */
app.get('/s/:token/data', async (request, reply) => {
  const token = (request.params as { token: string }).token;
  const found = await findShare(token);
  if (!found || !found.encrypted) return reply.code(404).send({ message: 'Ссылка недоступна' });
  if (!shareUnlocked(request, found.share))
    return reply.code(401).send({ message: 'Нужен пароль ссылки' });
  reply.header('Cache-Control', 'no-store');
  return {
    payload: found.encrypted.payload,
    updated_at: found.encrypted.updated_at,
    hideTitle: Boolean(found.meta.hideTitle),
    title: found.meta.hideTitle ? '' : found.meta.title,
  };
});
app.get('/s/:token/img/:id', async (request, reply) => {
  const { token, id } = request.params as { token: string; id: string };
  if (!/^[a-f0-9]{64}$/.test(id)) return reply.code(404).send();
  const found = await findShare(token);
  if (!found || !shareUnlocked(request, found.share)) return reply.code(404).send();
  // отдаём только картинки этой заметки
  let referenced = false;
  if (found.encrypted)
    referenced = (JSON.parse(found.encrypted.attachments) as string[]).includes(id);
  else {
    const note = await noteDocument(found.share.note_id);
    if (note)
      try {
        referenced = renderDocument(note.doc.getXmlFragment('content')).images.includes(
          `/api/attachments/${id}`,
        );
      } finally {
        note.release();
      }
  }
  if (!referenced) return reply.code(404).send();
  const row = await database()
    .selectFrom('attachments')
    .select('id')
    .where('id', '=', id)
    .where('owner_id', '=', found.share.owner_id)
    .executeTakeFirst();
  if (!row) return reply.code(404).send();
  reply.header('Cache-Control', 'private, max-age=3600');
  reply.header('X-Content-Type-Options', 'nosniff');
  return reply
    .type('image/webp')
    .send(await readFile(path.join(dataDir, 'attachments', found.share.owner_id, `${id}.webp`)));
});

// ===== Резервные копии =====
async function requireAdmin(request: import('fastify').FastifyRequest) {
  const id = await userId(request);
  const row = await database()
    .selectFrom('users')
    .select('role')
    .where('id', '=', id)
    .executeTakeFirst();
  if (row?.role !== 'admin')
    throw Object.assign(new Error('Доступно только администратору'), { statusCode: 403 });
  return id;
}
async function databaseType() {
  try {
    const config = JSON.parse(await readFile(path.join(dataDir, 'database.json'), 'utf8'));
    return String(config.type);
  } catch {
    return 'unknown';
  }
}
let backingUp: Promise<Awaited<ReturnType<typeof createBackup>>> | null = null;
function runBackup(kind: 'auto' | 'manual' | 'before-restore') {
  if (!backingUp)
    backingUp = (async () => createBackup(database(), kind, await databaseType()))().finally(() => {
      backingUp = null;
    });
  return backingUp;
}
/** Отключить всех и дождаться, пока сервер выгрузит документы из памяти. */
async function quiesceDocuments() {
  collab.closeConnections();
  const deadline = Date.now() + 30000;
  while (collab.getDocumentsCount() > 0 && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 100));
  await serializeDocuments(async () => undefined);
}
const backupTimer = scheduleBackups(async () => {
  if (!db || maintenance) return;
  try {
    const result = await runBackup('auto');
    app.log.info({ backup: result.name }, 'Резервная копия создана');
  } catch (error) {
    app.log.error(error, 'Не удалось создать резервную копию');
  }
});
app.get('/api/admin/backups', async (request) => {
  await requireAdmin(request);
  return {
    backups: await listBackups(),
    status: await readStatus(),
    schedule: {
      enabled: backupsEnabled(),
      hour: backupHour(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
    directory: backupDir(),
  };
});
app.post('/api/admin/backups', async (request) => {
  await requireAdmin(request);
  return runBackup('manual');
});
app.get('/api/admin/backups/:name', async (request, reply) => {
  await requireAdmin(request);
  const name = (request.params as { name: string }).name;
  const file = path.join(backupDir(), name);
  if (!isBackupName(name)) return reply.code(404).send({ message: 'Копия не найдена' });
  try {
    await access(file);
  } catch {
    return reply.code(404).send({ message: 'Копия не найдена' });
  }
  reply.header('Content-Type', 'application/zip');
  reply.header('Content-Disposition', `attachment; filename="${name}"`);
  reply.header('Cache-Control', 'no-store');
  return reply.send(createReadStream(file));
});
app.delete('/api/admin/backups/:name', async (request, reply) => {
  await requireAdmin(request);
  const name = (request.params as { name: string }).name;
  if (!isBackupName(name)) return reply.code(404).send({ message: 'Копия не найдена' });
  await rm(path.join(backupDir(), name), { force: true });
  return { ok: true };
});
/** Восстановление на работающем сервере: из загруженного файла или из списка копий. */
app.post('/api/admin/restore', async (request, reply) => {
  await requireAdmin(request);
  let bytes: Uint8Array;
  if (request.isMultipart()) {
    const file = await request.file({ limits: { fileSize: MAX_BACKUP_BYTES, files: 1 } });
    if (!file) return reply.code(400).send({ message: 'Выберите файл резервной копии' });
    bytes = await file.toBuffer();
    if (file.file.truncated) return reply.code(413).send({ message: 'Файл слишком большой' });
  } else {
    const { name } = z.object({ name: z.string() }).parse(request.body);
    if (!isBackupName(name)) return reply.code(404).send({ message: 'Копия не найдена' });
    bytes = await readFile(path.join(backupDir(), name));
  }
  await inspectBackup(bytes);
  if (maintenance) return reply.code(409).send({ message: 'Восстановление уже выполняется' });
  maintenance = true;
  try {
    const safety = await runBackup('before-restore');
    await quiesceDocuments();
    const result = await serializeDocuments(() => restoreBackup(database(), bytes));
    app.log.warn({ result, safety: safety.name }, 'Данные восстановлены из резервной копии');
    return { ...result, safety: safety.name };
  } finally {
    maintenance = false;
  }
});
/** Восстановление на чистом сервере — вместо мастера первого запуска. */
app.post(
  '/api/setup/restore',
  { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
  async (request, reply) => {
    if (settingUp || (db && (await db.selectFrom('users').select('id').executeTakeFirst())))
      return reply.code(409).send({ message: 'Сервис уже настроен или настройка выполняется' });
    if (!request.isMultipart())
      return reply.code(400).send({ message: 'Загрузите файл резервной копии' });
    let config: z.infer<typeof databaseConfig> | undefined;
    let bytes: Uint8Array | undefined;
    for await (const part of request.parts({ limits: { fileSize: MAX_BACKUP_BYTES, files: 1 } })) {
      if (part.type === 'file') {
        bytes = await part.toBuffer();
        if (part.file.truncated) return reply.code(413).send({ message: 'Файл слишком большой' });
      } else if (part.fieldname === 'database')
        config = databaseConfig.parse(JSON.parse(String(part.value)));
    }
    if (!bytes || !config)
      return reply.code(400).send({ message: 'Нужны файл копии и параметры базы данных' });
    await inspectBackup(bytes);
    settingUp = true;
    let conn: DB | undefined;
    try {
      conn = await openDatabase(config);
      if (await conn.selectFrom('users').select('id').executeTakeFirst())
        return reply.code(409).send({ message: 'Выбранная база уже содержит данные' });
      const result = await restoreBackup(conn, bytes);
      const admin = await conn
        .selectFrom('users')
        .select('id')
        .where('role', '=', 'admin')
        .executeTakeFirst();
      if (!admin) throw Object.assign(new Error('В копии нет администратора'), { statusCode: 400 });
      await activateDatabase(conn, config);
      conn = undefined;
      return { ok: true, ...result };
    } finally {
      settingUp = false;
      if (conn) await conn.destroy();
    }
  },
);
await runCleanup();
try {
  await access(webRoot);
  await app.register(serveStatic, { root: webRoot });
  app.setNotFoundHandler((request, reply) =>
    request.url.startsWith('/api/')
      ? reply.code(404).send({ message: 'Не найдено' })
      : reply.sendFile('index.html'),
  );
} catch {
  app.log.info('Фронтенд не собран: используйте Vite на порту 5173');
}
const shutdown = async () => {
  clearInterval(cleanupTimer);
  clearInterval(backupTimer);
  await new Promise<void>((resolve) => {
    collab.configuration.extensions.push({
      async afterUnloadDocument({ instance }) {
        if (instance.getDocumentsCount() === 0) resolve();
      },
    });
    collab.closeConnections();
    if (collab.getDocumentsCount() === 0) resolve();
  });
  await app.close();
  await db?.destroy();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
await app.listen({ port: Number(process.env.PORT || 1339), host: process.env.HOST || '0.0.0.0' });

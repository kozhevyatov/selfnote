import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import serveStatic from '@fastify/static';
import { Hocuspocus } from '@hocuspocus/server';
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
} from '@selfnote/shared';
import { db, dataDir, loadDatabase, openDatabase, activateDatabase, type DB } from './db.js';
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
  user: { id: string; name: string; email: string },
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
    user: { id: user.id, name: user.name, email: user.email },
  };
}
let settingUp = false;
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
        database: z.discriminatedUnion('type', [
          z.object({ type: z.literal('sqlite') }),
          z.object({
            type: z.literal('mariadb'),
            host: z.string().min(1),
            port: z.number().int().min(1).max(65535),
            database: z.string().min(1),
            user: z.string().min(1),
            password: z.string(),
          }),
        ]),
      })
      .parse(request.body);
    settingUp = true;
    let conn: DB | undefined;
    try {
      conn = await openDatabase(input.database);
      if (await conn.selectFrom('users').select('id').executeTakeFirst())
        return reply.code(409).send({ message: 'Выбранная база уже настроена' });
      const user = { id: randomUUID(), name: input.name, email: input.email };
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
    const user = { id: randomUUID(), email: input.email, name: input.name };
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
    .select(['id', 'name', 'email'])
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
  return database()
    .selectFrom('sessions')
    .select(['id', 'created_at', 'expires_at'])
    .where('user_id', '=', id)
    .execute();
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
async function authorizeDocument(name: string, owner: string) {
  if (name === `space:${owner}`) return;
  if (!/^note:[0-9a-f-]{36}$/.test(name))
    throw Object.assign(new Error('Нет доступа'), { statusCode: 403 });
  const purged = await database()
    .selectFrom('purged_notes')
    .select('note_id')
    .where('note_id', '=', name.slice(5))
    .executeTakeFirst();
  if (purged) throw Object.assign(new Error('Заметка удалена навсегда'), { statusCode: 410 });
  const row = await database()
    .selectFrom('yjs_documents')
    .select('owner_id')
    .where('name', '=', name)
    .executeTakeFirst();
  if (row && row.owner_id !== owner)
    throw Object.assign(new Error('Нет доступа'), { statusCode: 403 });
}
let saving: Promise<unknown> = Promise.resolve();
function serializeDocuments<T>(operation: () => Promise<T>): Promise<T> {
  const next = saving.then(operation);
  saving = next.catch(() => undefined);
  return next;
}
function saveDocument(name: string, document: Y.Doc, owner: string) {
  return serializeDocuments(() => storeDocument(name, document, owner));
}
async function storeDocument(name: string, document: Y.Doc, owner: string) {
  if (
    name.startsWith('note:') &&
    (await database()
      .selectFrom('purged_notes')
      .select('note_id')
      .where('note_id', '=', name.slice(5))
      .executeTakeFirst())
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
            .values({ id: randomUUID(), note_id: noteId, author: owner, state, created_at: now })
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
  async onAuthenticate({ token, documentName }) {
    const claims = app.jwt.verify<{ sub: string; sid: string }>(token);
    const session = await database()
      .selectFrom('sessions')
      .select('id')
      .where('id', '=', claims.sid)
      .where('user_id', '=', claims.sub)
      .where('expires_at', '>', new Date().toISOString())
      .executeTakeFirst();
    if (!session) throw new Error('Сессия завершена');
    await authorizeDocument(documentName, claims.sub);
    return { owner: claims.sub, sid: claims.sid };
  },
  async beforeHandleMessage({ context, documentName }) {
    await restoring;
    await authorizeDocument(documentName, (context as { owner: string }).owner);
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
      if (row.owner_id !== owner)
        throw Object.assign(new Error('Нет доступа'), { statusCode: 403 });
      Y.applyUpdate(document, row.state);
    }
    return document;
  },
  async onStoreDocument({ documentName, document, context }) {
    const { owner, historyOperation } = context as { owner: string; historyOperation?: boolean };
    if (historyOperation) await storeDocument(documentName, document, owner);
    else await saveDocument(documentName, document, owner);
  },
});
app.get('/collab', { websocket: true }, (socket, request) =>
  collab.handleConnection(socket, request.raw),
);
app.get('/api/tasks', async (request) => {
  const owner = await userId(request);
  // задачи из заметок в корзине не показываем
  return database()
    .selectFrom('tasks')
    .innerJoin('notes_index', 'notes_index.note_id', 'tasks.note_id')
    .selectAll('tasks')
    .where('tasks.owner_id', '=', owner)
    .where('notes_index.deleted', '=', 0)
    .execute();
});
async function ownedNote(id: string, owner: string) {
  await authorizeDocument(`note:${id}`, owner);
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
    await ownedNote(id, owner);
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
    await authorizeDocument(`note:${id}`, owner);
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
  const owner = await userId(request);
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
  const row = await database()
    .selectFrom('attachments')
    .select('id')
    .where('id', '=', id)
    .where('owner_id', '=', owner)
    .executeTakeFirst();
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
await runCleanup();
const webRoot = fileURLToPath(new URL('../../web/dist/', import.meta.url));
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

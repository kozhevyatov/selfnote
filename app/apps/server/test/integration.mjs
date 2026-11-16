import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, copyFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { extractDocument, setTaskChecked } from '@selfnote/shared';
import SQLite from 'better-sqlite3';
import sharp from 'sharp';
const data = await mkdtemp(path.join(tmpdir(), 'selfnote-integration-'));
const port = 14339;
const base = `http://127.0.0.1:${port}`;
let output = '';
function startServer() {
  const child = spawn(process.execPath, ['apps/server/dist/index.js'], {
    env: { ...process.env, DATA_DIR: data, PORT: String(port), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  return child;
}
let server = startServer();
const providers = [];
const sockets = [];
const docs = [];
async function waitFor(fn, label) {
  for (let i = 0; i < 100; i++) {
    if (await fn()) return;
    await delay(50);
  }
  throw new Error(`Ожидание: ${label}`);
}
async function request(url, body, token, cookie, method = body ? 'POST' : 'GET') {
  return fetch(base + url, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}
function connect(name, token, doc = new Y.Doc()) {
  docs.push(doc);
  const socket = new HocuspocusProviderWebsocket({
    url: `ws://127.0.0.1:${port}/collab`,
    WebSocketPolyfill: WebSocket,
  });
  sockets.push(socket);
  const provider = new HocuspocusProvider({
    name,
    document: doc,
    token,
    websocketProvider: socket,
  });
  provider.attach();
  providers.push(provider);
  return { provider, socket, doc };
}
try {
  await waitFor(async () => {
    try {
      return (await request('/api/health')).ok;
    } catch {
      return false;
    }
  }, 'запуск сервера');
  assert.equal((await (await request('/api/setup')).json()).required, true);
  const setup = {
    name: 'Тест',
    email: 'owner@example.test',
    password: 'test-password-2026',
    registration: 'open',
    database: { type: 'sqlite' },
  };
  let r = await request('/api/setup', setup);
  assert.equal(r.status, 200);
  const owner = await r.json();
  const cookie = r.headers.get('set-cookie').split(';')[0];
  assert.equal((await request('/api/setup', setup)).status, 409);
  assert.equal(
    (await request('/api/auth/login', { email: setup.email, password: 'wrong-password' })).status,
    401,
  );
  assert.equal((await request('/api/tasks')).status, 401);
  assert.equal((await request('/api/auth/refresh', {}, undefined, cookie)).status, 200);
  console.log('✓ Настройка SQLite, защита повторной настройки, вход и refresh');
  const noteId = randomUUID();
  const name = `note:${noteId}`;
  const a = connect(name, owner.accessToken);
  await waitFor(() => a.provider.isSynced, 'первый клиент');
  const b = connect(name, owner.accessToken);
  await waitFor(() => b.provider.isSynced, 'второй клиент');
  const list = new Y.XmlElement('taskList'),
    item = new Y.XmlElement('taskItem'),
    p = new Y.XmlElement('paragraph'),
    text = new Y.XmlText();
  const taskId = randomUUID();
  item.setAttribute('id', taskId);
  item.setAttribute('checked', false);
  item.setAttribute('due', '2026-11-15');
  text.insert(0, 'Проверить синхронизацию');
  p.insert(0, [text]);
  item.insert(0, [p]);
  list.insert(0, [item]);
  a.doc.getXmlFragment('content').insert(0, [list]);
  await waitFor(() => extractDocument(b.doc).tasks.length === 1, 'синхронизация задачи');
  b.socket.disconnect();
  await waitFor(() => b.socket.status === 'disconnected', 'отключение второго клиента');
  setTaskChecked(b.doc, taskId, true);
  const para = new Y.XmlElement('paragraph'),
    tx = new Y.XmlText();
  tx.insert(0, 'Правка первого клиента');
  para.insert(0, [tx]);
  a.doc.getXmlFragment('content').push([para]);
  b.socket.connect();
  await waitFor(
    () =>
      extractDocument(a.doc).tasks[0]?.checked &&
      extractDocument(b.doc).plainText.includes('Правка первого клиента'),
    'объединение офлайн-правок',
  );
  assert.deepEqual(extractDocument(a.doc), extractDocument(b.doc));
  console.log('✓ Два WebSocket-клиента и объединение правок после отключения');
  const offlineDoc = new Y.Doc();
  const offlineParagraph = new Y.XmlElement('paragraph');
  const offlineText = new Y.XmlText();
  offlineText.insert(0, 'Создано без сети');
  offlineParagraph.insert(0, [offlineText]);
  offlineDoc.getXmlFragment('content').push([offlineParagraph]);
  const offlineName = `note:${randomUUID()}`;
  const offlineClient = connect(offlineName, owner.accessToken, offlineDoc);
  await waitFor(() => offlineClient.provider.isSynced, 'публикация офлайн-заметки');
  const reader = connect(offlineName, owner.accessToken);
  await waitFor(
    () => extractDocument(reader.doc).plainText === 'Создано без сети',
    'получение новой офлайн-заметки',
  );
  console.log('✓ Заметка, созданная до подключения, приходит на второй клиент');

  await waitFor(async () => {
    const rows = await (await request('/api/tasks', undefined, owner.accessToken)).json();
    return rows.some((t) => t.id === taskId && t.checked === 1);
  }, 'индекс задач');
  // Пункт чек-листа скопирован в другую заметку вместе с id — обе заметки должны сохраниться.
  const copyDoc = new Y.Doc();
  const copyList = new Y.XmlElement('taskList'),
    copyItem = new Y.XmlElement('taskItem'),
    copyP = new Y.XmlElement('paragraph'),
    copyText = new Y.XmlText();
  copyItem.setAttribute('id', taskId);
  copyItem.setAttribute('checked', false);
  copyText.insert(0, 'Скопированная задача');
  copyP.insert(0, [copyText]);
  copyItem.insert(0, [copyP]);
  copyList.insert(0, [copyItem]);
  copyDoc.getXmlFragment('content').insert(0, [copyList]);
  connect(`note:${randomUUID()}`, owner.accessToken, copyDoc);
  await waitFor(async () => {
    const rows = await (await request('/api/tasks', undefined, owner.accessToken)).json();
    return rows.filter((t) => t.id === taskId).length === 2;
  }, 'одинаковый id задачи в двух заметках');
  console.log('✓ Одинаковый id задачи в разных заметках не ломает сохранение');
  const sql = new SQLite(path.join(data, 'selfnote.sqlite'));
  assert.ok(sql.prepare('select count(*) as count from note_versions').get().count >= 1);
  assert.ok(
    sql
      .prepare('select plain_text from notes_index where note_id = ?')
      .get(noteId)
      .plain_text.includes('Правка первого клиента'),
  );
  sql.close();
  r = await request(
    `/api/notes/${noteId}/versions`,
    { state: Buffer.from(Y.encodeStateAsUpdate(a.doc)).toString('base64') },
    owner.accessToken,
  );
  assert.equal(r.status, 200);
  console.log('✓ Производные таблицы и снапшоты версий');
  r = await request('/api/auth/register', {
    name: 'Другой',
    email: 'other@example.test',
    password: 'another-password-2026',
  });
  assert.equal(r.status, 200);
  const other = await r.json();
  let denied = false;
  const stranger = connect(name, other.accessToken);
  stranger.provider.on('authenticationFailed', () => {
    denied = true;
  });
  await waitFor(() => denied, 'запрет доступа к чужой заметке');
  assert.equal(
    (
      await request(
        `/api/notes/${noteId}/versions`,
        { state: Buffer.from(Y.encodeStateAsUpdate(a.doc)).toString('base64') },
        other.accessToken,
      )
    ).status,
    403,
  );
  console.log('✓ Чужой пользователь не получает документ');
  const input = await sharp({
    create: { width: 20, height: 20, channels: 3, background: '#3451D1' },
  })
    .jpeg()
    .withMetadata({ exif: { IFD0: { Artist: 'test' } } })
    .toBuffer();
  const form = new FormData();
  form.append('file', new Blob([input], { type: 'image/jpeg' }), 'test.jpg');
  r = await fetch(base + '/api/attachments', {
    method: 'POST',
    headers: { Authorization: `Bearer ${owner.accessToken}` },
    body: form,
  });
  assert.equal(r.status, 200);
  const attachment = await r.json();
  r = await request(attachment.url, undefined, owner.accessToken);
  assert.equal(r.status, 200);
  const metadata = await sharp(Buffer.from(await r.arrayBuffer())).metadata();
  assert.equal(metadata.format, 'webp');
  assert.equal(metadata.exif, undefined);
  assert.equal((await request(attachment.url, undefined, other.accessToken)).status, 404);
  assert.equal((await request(attachment.url)).status, 401);
  console.log('✓ Изображения: EXIF удалён, доступ ограничен владельцем');
  const versionsUrl = `/api/notes/${noteId}/versions`;
  let versions = await (await request(versionsUrl, undefined, owner.accessToken)).json();
  assert.ok(versions.length);
  assert.ok(versions.every((v) => !('state' in v) && v.author_name === 'Тест'));
  const savedVersion = versions[0];
  const detail = await (
    await request(`${versionsUrl}/${savedVersion.id}`, undefined, owner.accessToken)
  ).json();
  const expected = new Y.Doc();
  Y.applyUpdate(expected, Buffer.from(detail.state, 'base64'));
  a.doc.getXmlFragment('content').delete(0, a.doc.getXmlFragment('content').length);
  await waitFor(
    () => extractDocument(b.doc).plainText === '',
    'удаление содержимого до восстановления',
  );
  assert.equal(
    (await request(`${versionsUrl}/${savedVersion.id}/restore`, {}, owner.accessToken)).status,
    200,
  );
  await waitFor(
    () => extractDocument(b.doc).plainText === extractDocument(expected).plainText,
    'восстановление на второй реплике',
  );
  assert.deepEqual(extractDocument(a.doc), extractDocument(expected));
  expected.destroy();
  versions = await (await request(versionsUrl, undefined, owner.accessToken)).json();
  assert.ok(versions.some((v) => v.label === 'До восстановления'));
  assert.ok(versions.some((v) => v.label === 'Восстановленная версия'));
  for (const suffix of ['', `/${savedVersion.id}`])
    assert.equal((await request(versionsUrl + suffix, undefined, other.accessToken)).status, 403);
  assert.equal(
    (await request(`${versionsUrl}/${savedVersion.id}/restore`, {}, other.accessToken)).status,
    403,
  );
  assert.equal(
    (
      await request(
        `/api/notes/${offlineName.slice(5)}/versions/${savedVersion.id}`,
        undefined,
        owner.accessToken,
      )
    ).status,
    404,
  );
  console.log(
    '✓ История: список без state, автор, просмотр, права и восстановление на двух репликах',
  );

  const space = connect(`space:${owner.user.id}`, owner.accessToken);
  const spacePeer = connect(`space:${owner.user.id}`, owner.accessToken);
  await waitFor(() => space.provider.isSynced && spacePeer.provider.isSynced, 'пространства');
  space.doc.getMap('notes').set(noteId, new Y.Map([['deletedAt', new Date().toISOString()]]));
  await waitFor(
    async () =>
      !(await (await request('/api/tasks', undefined, owner.accessToken)).json()).some(
        (t) => t.note_id === noteId,
      ),
    'задача в корзине',
  );
  space.doc.getMap('notes').get(noteId).set('deletedAt', null);
  await waitFor(
    async () =>
      (await (await request('/api/tasks', undefined, owner.accessToken)).json()).some(
        (t) => t.note_id === noteId,
      ),
    'восстановление из корзины',
  );
  const stale = new Y.Doc();
  Y.applyUpdate(stale, Y.encodeStateAsUpdate(a.doc));
  space.doc
    .getMap('notes')
    .get(noteId)
    .set('deletedAt', new Date(Date.now() - 31 * 86400000).toISOString());
  await waitFor(
    () => !spacePeer.doc.getMap('notes').has(noteId),
    'автоочистка на другом устройстве',
  );
  const inspect = new SQLite(path.join(data, 'selfnote.sqlite'));
  await waitFor(
    () => !inspect.prepare('select name from yjs_documents where name = ?').get(name),
    'удаление тела заметки',
  );
  for (const table of ['tasks', 'note_versions', 'notes_index'])
    assert.equal(
      inspect.prepare(`select count(*) as n from ${table} where note_id = ?`).get(noteId).n,
      0,
    );
  assert.equal((await request(versionsUrl, undefined, owner.accessToken)).status, 410);
  const reconnectDeleted = connect(name, owner.accessToken, stale);
  let deletedDenied = false;
  reconnectDeleted.provider.on('authenticationFailed', () => {
    deletedDenied = true;
  });
  await waitFor(() => deletedDenied, 'старый офлайн-клиент не воскрешает заметку');
  space.doc.getMap('notes').set(noteId, { deletedAt: null });
  await waitFor(
    () => !space.doc.getMap('notes').has(noteId),
    'защита метаданных от старого клиента',
  );
  // Окончательное удаление даже свежей заметки через синхронизируемую отметку.
  space.doc.transact(() => {
    space.doc.getMap('notes').set(offlineName.slice(5), { deletedAt: new Date().toISOString() });
    space.doc.getMap('purged').set(offlineName.slice(5), true);
    space.doc.getMap('notes').delete(offlineName.slice(5));
  });
  await waitFor(
    () => !inspect.prepare('select name from yjs_documents where name = ?').get(offlineName),
    'ручная очистка',
  );
  inspect.close();
  console.log(
    '✓ Корзина: восстановление, 31 день, очистка таблиц, ручное удаление и защита от офлайн-воскрешения',
  );

  const csrf = await fetch(base + '/api/auth/logout', {
    method: 'POST',
    headers: { Origin: 'https://foreign.example', Cookie: cookie },
  });
  assert.equal(csrf.status, 403);
  assert.equal((await request('/api/auth/logout', {}, undefined, cookie)).status, 200);
  assert.equal((await request('/api/tasks', undefined, owner.accessToken)).status, 401);
  assert.equal((await request('/api/auth/refresh', {}, undefined, cookie)).status, 401);
  console.log('✓ CSRF и отзыв сессии');
  // Проверяем фоновую уборку на старте без участия клиента.
  for (const provider of providers) provider.destroy();
  for (const socket of sockets) socket.destroy();
  server.kill('SIGTERM');
  await once(server, 'exit');
  const fixture = new SQLite(path.join(data, 'selfnote.sqlite'));
  const oldDate = new Date(Date.now() - 31 * 86400000).toISOString();
  const expiredId = randomUUID();
  const retainedId = randomUUID();
  const fixtureDoc = new Y.Doc();
  const image = new Y.XmlElement('image');
  image.setAttribute('src', attachment.url);
  fixtureDoc.getXmlFragment('content').insert(0, [image]);
  const imageState = Buffer.from(Y.encodeStateAsUpdate(fixtureDoc));
  fixtureDoc.destroy();
  for (const id of [expiredId, retainedId]) {
    fixture
      .prepare('insert into yjs_documents (name, owner_id, state, updated_at) values (?, ?, ?, ?)')
      .run(`note:${id}`, owner.user.id, imageState, oldDate);
    fixture
      .prepare(
        'insert into notes_index (note_id, owner_id, plain_text, preview, updated_at, deleted, deleted_at) values (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        owner.user.id,
        '',
        '',
        oldDate,
        id === expiredId ? 1 : 0,
        id === expiredId ? oldDate : null,
      );
    fixture
      .prepare(
        'insert into note_versions (id, note_id, author, state, created_at) values (?, ?, ?, ?, ?)',
      )
      .run(randomUUID(), id, owner.user.id, imageState, oldDate);
  }
  // Только история живой заметки удерживает картинку.
  const empty = new Y.Doc();
  fixture
    .prepare('update yjs_documents set state = ? where name = ?')
    .run(Buffer.from(Y.encodeStateAsUpdate(empty)), `note:${retainedId}`);
  empty.destroy();
  const fixtureSpace = new Y.Doc();
  Y.applyUpdate(
    fixtureSpace,
    fixture.prepare('select state from yjs_documents where name = ?').get(`space:${owner.user.id}`)
      .state,
  );
  fixtureSpace.getMap('notes').set(expiredId, { deletedAt: oldDate });
  fixtureSpace.getMap('notes').set(retainedId, { deletedAt: null });
  fixture
    .prepare('update yjs_documents set state = ? where name = ?')
    .run(Buffer.from(Y.encodeStateAsUpdate(fixtureSpace)), `space:${owner.user.id}`);
  fixtureSpace.destroy();
  fixture.prepare('update attachments set created_at = ?').run(oldDate);
  const orphanId = 'f'.repeat(64);
  fixture
    .prepare(
      'insert into attachments (id, owner_id, filename, mime, created_at) values (?, ?, ?, ?, ?)',
    )
    .run(orphanId, owner.user.id, `${orphanId}.webp`, 'image/webp', oldDate);
  const attachmentDir = path.join(data, 'attachments', owner.user.id);
  await copyFile(
    path.join(attachmentDir, `${attachment.id}.webp`),
    path.join(attachmentDir, `${orphanId}.webp`),
  );
  fixture.close();
  server = startServer();
  await waitFor(async () => {
    try {
      return (await request('/api/health')).ok;
    } catch {
      return false;
    }
  }, 'перезапуск и фоновая уборка');
  const afterCleanup = new SQLite(path.join(data, 'selfnote.sqlite'));
  assert.equal(
    afterCleanup.prepare('select name from yjs_documents where name = ?').get(`note:${expiredId}`),
    undefined,
  );
  assert.equal(
    afterCleanup.prepare('select id from note_versions where note_id = ?').get(expiredId),
    undefined,
  );
  assert.ok(afterCleanup.prepare('select id from attachments where id = ?').get(attachment.id));
  assert.equal(
    afterCleanup.prepare('select id from attachments where id = ?').get(orphanId),
    undefined,
  );
  await access(path.join(attachmentDir, `${attachment.id}.webp`));
  await assert.rejects(access(path.join(attachmentDir, `${orphanId}.webp`)));
  afterCleanup.close();
  console.log(
    '✓ Уборка при старте без клиента: старая корзина и файлы удалены, картинка из истории сохранена',
  );
} catch (error) {
  console.error(output.slice(-12000));
  throw error;
} finally {
  for (const p of providers) p.destroy();
  for (const s of sockets) s.destroy();
  for (const d of docs) d.destroy();
  server.kill('SIGTERM');
  await Promise.race([once(server, 'exit'), delay(5000).then(() => server.kill('SIGKILL'))]);
  await rm(data, { recursive: true, force: true });
}

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
// Отложенный reconnect библиотеки может сработать уже после destroy().
// Завершённый тестовый клиент больше не должен открывать соединения.
class TestWebsocket extends HocuspocusProviderWebsocket {
  disposed = false;

  async connect() {
    if (this.disposed) return;
    return super.connect();
  }

  destroy() {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelWebsocketRetry?.();
    super.destroy();
  }
}
function connect(name, token, doc = new Y.Doc()) {
  docs.push(doc);
  const socket = new TestWebsocket({
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

  // Резервная копия: создание, список, скачивание, восстановление после «порчи» данных.
  const created = await request('/api/admin/backups', {}, owner.accessToken);
  assert.equal(created.status, 200, await created.clone().text());
  const backup = await created.json();
  assert.match(backup.name, /^selfnote-backup-.+-manual\.zip$/);
  const listing = await (await request('/api/admin/backups', undefined, owner.accessToken)).json();
  assert.ok(listing.backups.some((b) => b.name === backup.name));
  assert.equal(listing.status.lastFile, backup.name);
  assert.equal((await request('/api/admin/backups', undefined, other.accessToken)).status, 403);
  const download = await request(`/api/admin/backups/${backup.name}`, undefined, owner.accessToken);
  assert.equal(download.status, 200);
  const zipBytes = new Uint8Array(await download.arrayBuffer());
  assert.equal(String.fromCharCode(zipBytes[0], zipBytes[1]), 'PK');
  assert.equal(
    (await request('/api/admin/backups/../../etc/passwd', undefined, owner.accessToken)).status,
    404,
  );
  const damage = new SQLite(path.join(data, 'selfnote.sqlite'));
  const before = {
    docs: damage.prepare('select count(*) as n from yjs_documents').get().n,
    users: damage.prepare('select count(*) as n from users').get().n,
  };
  damage.prepare('delete from tasks').run();
  damage.prepare("delete from yjs_documents where name like 'note:%'").run();
  damage.close();
  const restored = await request('/api/admin/restore', { name: backup.name }, owner.accessToken);
  assert.equal(restored.status, 200, await restored.clone().text());
  const restoreResult = await restored.json();
  assert.match(restoreResult.safety, /before-restore/);
  const check = new SQLite(path.join(data, 'selfnote.sqlite'));
  assert.equal(check.prepare('select count(*) as n from yjs_documents').get().n, before.docs);
  assert.equal(check.prepare('select count(*) as n from users').get().n, before.users);
  check.close();
  assert.equal((await request('/api/tasks', undefined, owner.accessToken)).status, 200);
  console.log(
    '✓ Резервная копия: создание, скачивание, восстановление и копия перед восстановлением',
  );

  // ===== Этап 2: серверный поиск =====
  // после восстановления из копии прежние клиенты переподключаются с задержкой — берём новое соединение
  const spaceLive = connect(`space:${owner.user.id}`, owner.accessToken);
  await waitFor(() => spaceLive.provider.isSynced, 'пространство');
  const searchId = randomUUID();
  const searchNote = connect(`note:${searchId}`, owner.accessToken);
  await waitFor(() => searchNote.provider.isSynced, 'заметка для поиска');
  const sp = new Y.XmlElement('paragraph'),
    st = new Y.XmlText();
  st.insert(0, 'Плейлист для утреннего эфира и джинглы');
  sp.insert(0, [st]);
  searchNote.doc.getXmlFragment('content').insert(0, [sp]);
  spaceLive.doc.getMap('notes').set(
    searchId,
    new Y.Map([
      ['title', 'Публичная заметка'],
      ['deletedAt', null],
    ]),
  );
  let found = [];
  await waitFor(async () => {
    found = await (
      await request(
        `/api/search?q=${encodeURIComponent('утрен ДЖИНГ')}`,
        undefined,
        owner.accessToken,
      )
    ).json();
    return found.some((r) => r.id === searchId);
  }, 'серверный поиск');
  assert.ok(found[0].parts.some((p) => p.mark && p.text.toLowerCase().startsWith('утрен')));
  assert.deepEqual(
    await (await request('/api/search?q=несуществующее', undefined, owner.accessToken)).json(),
    [],
  );
  console.log('✓ Серверный поиск: по началу слова, без регистра, с фрагментом');

  // ===== Публичные ссылки =====
  r = await request(`/api/notes/${searchId}/shares`, {}, owner.accessToken);
  assert.equal(r.status, 200);
  const share = await r.json();
  assert.equal(share.has_password, false);
  let page;
  await waitFor(async () => {
    page = await fetch(`${base}/s/${share.token}`);
    return page.status === 200;
  }, 'публичная страница');
  let html = await page.text();
  assert.ok(html.includes('Публичная заметка') && html.includes('утреннего эфира'));
  assert.ok(html.includes('og:title') && page.headers.get('content-security-policy'));
  assert.equal((await fetch(`${base}/s/${'x'.repeat(43)}`)).status, 404);
  r = await request(`/api/notes/${searchId}/shares`, { password: 'секрет-1' }, owner.accessToken);
  const locked = await r.json();
  html = await (await fetch(`${base}/s/${locked.token}`)).text();
  assert.ok(html.includes('защищена паролем') && !html.includes('утреннего эфира'));
  assert.equal((await request(`/s/${locked.token}/unlock`, { password: 'неверный' })).status, 401);
  r = await request(`/s/${locked.token}/unlock`, { password: 'секрет-1' });
  assert.equal(r.status, 200);
  const shareCookie = r.headers.get('set-cookie').split(';')[0];
  html = await (
    await fetch(`${base}/s/${locked.token}`, { headers: { Cookie: shareCookie } })
  ).text();
  assert.ok(html.includes('утреннего эфира'));
  const shares = await (await request('/api/shares', undefined, owner.accessToken)).json();
  assert.equal(shares.length, 2);
  assert.ok(shares.every((s) => !('password_hash' in s)));
  assert.equal(
    (await request(`/api/shares/${share.id}`, undefined, owner.accessToken, undefined, 'DELETE'))
      .status,
    200,
  );
  assert.equal((await fetch(`${base}/s/${share.token}`)).status, 404);
  spaceLive.doc.getMap('notes').get(searchId).set('deletedAt', new Date().toISOString());
  await waitFor(
    async () =>
      (await fetch(`${base}/s/${locked.token}`, { headers: { Cookie: shareCookie } })).status ===
      404,
    'ссылка на заметку в корзине',
  );
  spaceLive.doc.getMap('notes').get(searchId).set('deletedAt', null);
  console.log('✓ Публичные ссылки: страница, превью, пароль ссылки, отзыв, корзина');

  // ===== Заметки под паролем =====
  const envelope = (data) =>
    JSON.stringify({
      v: 1,
      kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 1000, salt: 'AAAA' },
      iv: 'AAAA',
      data,
    });
  const put = (id, body) =>
    fetch(`${base}/api/encrypted/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${owner.accessToken}` },
      body: JSON.stringify(body),
    });
  // закрываем паролем существующую заметку: открытый текст и история удаляются
  r = await put(searchId, { version: 0, payload: envelope('шифр-1'), attachments: [] });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).version, 1);
  const checkDb = new SQLite(path.join(data, 'selfnote.sqlite'));
  await waitFor(
    () => !checkDb.prepare('select name from yjs_documents where name = ?').get(`note:${searchId}`),
    'открытый текст удалён',
  );
  for (const table of ['notes_index', 'note_versions', 'tasks', 'shares'])
    assert.equal(
      checkDb.prepare(`select count(*) as n from ${table} where note_id = ?`).get(searchId).n,
      0,
    );
  checkDb.close();
  assert.deepEqual(
    await (await request(`/api/search?q=утрен`, undefined, owner.accessToken)).json(),
    [],
  );
  let encryptedDenied = false;
  const reopen = connect(`note:${searchId}`, owner.accessToken);
  reopen.provider.on('authenticationFailed', () => (encryptedDenied = true));
  await waitFor(() => encryptedDenied, 'WebSocket не отдаёт заметку под паролем');
  r = await put(searchId, { version: 0, payload: envelope('устаревшая'), attachments: [] });
  assert.equal(r.status, 409);
  const conflict = await r.json();
  assert.equal(conflict.version, 1);
  assert.ok(conflict.payload.includes('шифр-1'));
  r = await put(searchId, {
    version: 1,
    payload: envelope('шифр-2'),
    attachments: ['a'.repeat(64)],
  });
  assert.equal((await r.json()).version, 2);
  assert.equal((await put(searchId, { version: 2, payload: 'не конверт' })).status, 400);
  const listed = await (await request('/api/encrypted', undefined, owner.accessToken)).json();
  assert.deepEqual(
    listed.map((n) => [n.note_id, n.version]),
    [[searchId, 2]],
  );
  // ссылка на зашифрованную заметку: страница без содержимого, шифр — отдельно
  const secret = await (
    await request(`/api/notes/${searchId}/shares`, {}, owner.accessToken)
  ).json();
  assert.equal(secret.encrypted, 1);
  html = await (await fetch(`${base}/s/${secret.token}`)).text();
  assert.ok(html.includes('data-encrypted="1"') && !html.includes('Публичная заметка'));
  const secretData = await (await fetch(`${base}/s/${secret.token}/data`)).json();
  assert.ok(secretData.payload.includes('шифр-2'));
  // снять пароль: заметка снова принимается по WebSocket
  assert.equal(
    (await request(`/api/encrypted/${searchId}`, undefined, owner.accessToken, undefined, 'DELETE'))
      .status,
    200,
  );
  assert.equal((await fetch(`${base}/s/${secret.token}`)).status, 404);
  const plainAgain = connect(`note:${searchId}`, owner.accessToken);
  await waitFor(() => plainAgain.provider.isSynced, 'заметка без пароля снова синхронизируется');
  console.log(
    '✓ Заметки под паролем: шифр вместо текста, версии и конфликт, ссылка, снятие пароля',
  );

  // Совместная заметка между аккаунтами: приглашения, роли и серверные границы доступа.
  const collabId = randomUUID();
  const co = connect(`note:${collabId}`, owner.accessToken);
  await waitFor(() => co.provider.isSynced, 'совместная заметка владельца');
  spaceLive.doc.getMap('notes').set(
    collabId,
    new Y.Map(
      Object.entries({
        id: collabId,
        title: 'Совместный план',
        notebookId: null,
        sectionId: null,
        tags: [],
        pinned: false,
        deletedAt: null,
        encrypted: false,
        color: null,
        updatedAt: new Date().toISOString(),
      }),
    ),
  );
  const cp = new Y.XmlElement('paragraph'),
    ct = new Y.XmlText();
  ct.insert(0, 'Коллаборация проверяется');
  cp.insert(0, [ct]);
  co.doc.getXmlFragment('content').insert(0, [cp]);
  await waitFor(
    () => !spaceLive.provider.hasUnsyncedChanges && !co.provider.hasUnsyncedChanges,
    'метаданные совместной заметки',
  );
  const membersUrl = `/api/notes/${collabId}/members`;
  r = await request(membersUrl, { email: 'other@example.test', role: 'editor' }, owner.accessToken);
  assert.equal(r.status, 200, await r.text());
  assert.equal((await request(membersUrl, undefined, other.accessToken)).status, 403);
  let invitations = await (
    await request('/api/collaboration', undefined, other.accessToken)
  ).json();
  assert.equal(invitations.notes.find((n) => n.note.id === collabId).pending, true);
  assert.equal(
    (await request(`/api/notes/${collabId}/versions`, undefined, other.accessToken)).status,
    403,
  );
  const pendingClient = connect(`note:${collabId}`, other.accessToken);
  let pendingDenied = false;
  pendingClient.provider.on('authenticationFailed', () => {
    pendingDenied = true;
  });
  await waitFor(() => pendingDenied, 'приглашение не даёт доступ до принятия');
  pendingClient.provider.destroy();
  pendingClient.socket.destroy();
  assert.equal(
    (await request(`/api/notes/${collabId}/membership/accept`, {}, other.accessToken)).status,
    200,
  );
  const editorClient = connect(`note:${collabId}`, other.accessToken);
  await waitFor(() => editorClient.provider.isSynced, 'приглашённый редактор');
  assert.match(extractDocument(editorClient.doc).plainText, /Коллаборация/);
  editorClient.doc.getMap('collaboration').set('title', 'Общее название');
  const ep = new Y.XmlElement('paragraph'),
    et = new Y.XmlText();
  et.insert(0, 'Правка редактора');
  ep.insert(0, [et]);
  editorClient.doc.getXmlFragment('content').push([ep]);
  await waitFor(
    () => extractDocument(co.doc).plainText.includes('Правка редактора'),
    'редактор меняет текст владельца',
  );
  assert.equal(co.doc.getMap('collaboration').get('title'), 'Общее название');
  editorClient.socket.disconnect();
  await waitFor(() => editorClient.socket.status === 'disconnected', 'редактор офлайн');
  et.insert(et.length, ' офлайн');
  ct.insert(ct.length, ' онлайн');
  await editorClient.socket.connect();
  await waitFor(
    () =>
      extractDocument(co.doc).plainText.includes('офлайн') &&
      extractDocument(editorClient.doc).plainText.includes('онлайн'),
    'слияние правок двух пользователей',
  );
  await waitFor(
    async () =>
      (
        await (await request('/api/search?q=Коллаборация', undefined, other.accessToken)).json()
      ).some((n) => n.id === collabId),
    'поиск общей заметки',
  );
  r = await request('/api/auth/register', {
    name: 'Читатель',
    email: 'reader@example.test',
    password: 'reader-password-2026',
  });
  assert.equal(r.status, 200);
  const invitedReader = await r.json();
  assert.equal(
    (await request(membersUrl, { email: 'reader@example.test', role: 'reader' }, owner.accessToken))
      .status,
    200,
  );
  assert.equal(
    (await request(`/api/notes/${collabId}/membership/accept`, {}, invitedReader.accessToken))
      .status,
    200,
  );
  const readerClient = connect(`note:${collabId}`, invitedReader.accessToken);
  await waitFor(() => readerClient.provider.isSynced, 'читатель синхронизирован');
  assert.equal(readerClient.provider.authorizedScope, 'readonly');
  readerClient.doc.getMap('collaboration').set('title', 'Запрещённая правка');
  const bad = new Y.XmlElement('paragraph'),
    badText = new Y.XmlText();
  badText.insert(0, 'Читатель не должен писать');
  bad.insert(0, [badText]);
  readerClient.doc.getXmlFragment('content').push([bad]);
  await delay(150);
  assert.equal(co.doc.getMap('collaboration').get('title'), 'Общее название');
  assert.ok(!extractDocument(co.doc).plainText.includes('Читатель не должен писать'));
  const coVersions = `/api/notes/${collabId}/versions`;
  const coState = Buffer.from(Y.encodeStateAsUpdate(editorClient.doc)).toString('base64');
  assert.equal(
    (await request(coVersions, { state: coState }, invitedReader.accessToken)).status,
    403,
  );
  assert.equal((await request(coVersions, { state: coState }, other.accessToken)).status, 200);
  const cv = await (await request(coVersions, undefined, invitedReader.accessToken)).json();
  assert.ok(cv.some((v) => v.author === other.user.id));
  assert.equal(
    (await request(`${coVersions}/${cv[0].id}/restore`, {}, invitedReader.accessToken)).status,
    403,
  );
  assert.equal(
    (await request(`${coVersions}/${cv[0].id}/restore`, {}, other.accessToken)).status,
    200,
  );
  assert.equal((await request(`/api/notes/${collabId}/shares`, {}, other.accessToken)).status, 404);
  assert.equal(
    (await request(membersUrl, { email: setup.email, role: 'editor' }, other.accessToken)).status,
    403,
  );
  const privateSpace = connect(`space:${owner.user.id}`, other.accessToken);
  let spaceDenied = false;
  privateSpace.provider.on('authenticationFailed', () => {
    spaceDenied = true;
  });
  await waitFor(() => spaceDenied, 'чужое пространство закрыто');
  privateSpace.provider.destroy();
  privateSpace.socket.destroy();
  assert.equal((await request(attachment.url, undefined, invitedReader.accessToken)).status, 404);
  const sharedForm = new FormData();
  const sharedImage = await sharp({
    create: { width: 12, height: 12, channels: 3, background: '#bb3344' },
  })
    .png()
    .toBuffer();
  sharedForm.append('file', new Blob([sharedImage], { type: 'image/png' }), 'shared.png');
  assert.equal(
    (
      await fetch(`${base}/api/attachments?noteId=${collabId}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${invitedReader.accessToken}` },
        body: sharedForm,
      })
    ).status,
    403,
  );
  r = await fetch(`${base}/api/attachments?noteId=${collabId}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${other.accessToken}` },
    body: sharedForm,
  });
  assert.equal(r.status, 200);
  const sharedAttachment = await r.json();
  const sharedImageNode = new Y.XmlElement('image');
  sharedImageNode.setAttribute('src', sharedAttachment.url);
  editorClient.doc.getXmlFragment('content').push([sharedImageNode]);
  await waitFor(
    () => co.doc.getXmlFragment('content').toString().includes(sharedAttachment.url),
    'картинка редактора синхронизирована',
  );
  assert.equal(
    (await request(sharedAttachment.url, undefined, invitedReader.accessToken)).status,
    200,
  );
  assert.equal((await request(sharedAttachment.url, undefined, owner.accessToken)).status, 200);
  assert.equal(
    (await put(collabId, { version: 0, payload: envelope('нельзя'), attachments: [] })).status,
    409,
  );
  // Понижение роли действует и для уже подключённого редактора.
  assert.equal(
    (
      await request(
        `${membersUrl}/${other.user.id}`,
        { role: 'reader' },
        owner.accessToken,
        undefined,
        'PATCH',
      )
    ).status,
    200,
  );
  await waitFor(
    () => editorClient.provider.authorizedScope === 'readonly' && editorClient.provider.isSynced,
    'роль понижена на открытом соединении',
  );
  editorClient.doc.getMap('collaboration').set('title', 'После понижения');
  await delay(150);
  assert.equal(co.doc.getMap('collaboration').get('title'), 'Общее название');
  assert.equal((await request(coVersions, { state: coState }, other.accessToken)).status, 403);
  // Отзыв закрывает соединение, историю, картинки и серверный поиск.
  let revoked = false;
  editorClient.provider.on('authenticationFailed', () => {
    revoked = true;
  });
  assert.equal(
    (
      await request(
        `${membersUrl}/${other.user.id}`,
        undefined,
        owner.accessToken,
        undefined,
        'DELETE',
      )
    ).status,
    200,
  );
  await waitFor(() => revoked, 'доступ отозван у открытого клиента');
  editorClient.provider.destroy();
  editorClient.socket.destroy();
  assert.equal((await request(coVersions, undefined, other.accessToken)).status, 403);
  assert.equal((await request(sharedAttachment.url, undefined, other.accessToken)).status, 404);
  assert.ok(
    !(
      await (await request('/api/search?q=Коллаборация', undefined, other.accessToken)).json()
    ).some((n) => n.id === collabId),
  );
  // Корзина скрывает заметку у участника, восстановление возвращает доступ.
  spaceLive.doc.getMap('notes').get(collabId).set('deletedAt', new Date().toISOString());
  await waitFor(
    async () =>
      !(
        await (await request('/api/collaboration', undefined, invitedReader.accessToken)).json()
      ).notes.some((n) => n.note.id === collabId),
    'общая заметка в корзине скрыта',
  );
  assert.equal((await request(coVersions, undefined, invitedReader.accessToken)).status, 403);
  spaceLive.doc.getMap('notes').get(collabId).set('deletedAt', null);
  await waitFor(
    async () =>
      (
        await (await request('/api/collaboration', undefined, invitedReader.accessToken)).json()
      ).notes.some((n) => n.note.id === collabId),
    'общая заметка восстановлена',
  );
  assert.equal(
    (
      await request(
        `${membersUrl}/${invitedReader.user.id}`,
        undefined,
        invitedReader.accessToken,
        undefined,
        'DELETE',
      )
    ).status,
    200,
  );
  // Приглашение можно отклонить и выдать заново.
  assert.equal(
    (await request(membersUrl, { email: 'reader@example.test', role: 'reader' }, owner.accessToken))
      .status,
    200,
  );
  assert.equal(
    (
      await request(
        `${membersUrl}/${invitedReader.user.id}`,
        undefined,
        invitedReader.accessToken,
        undefined,
        'DELETE',
      )
    ).status,
    200,
  );
  assert.equal(
    (await request(membersUrl, { email: 'reader@example.test', role: 'editor' }, owner.accessToken))
      .status,
    200,
  );
  // Приглашение в заметку человека без аккаунта: ссылка на регистрацию сразу даёт доступ.
  r = await request(
    membersUrl,
    { email: 'newbie@example.test', role: 'reader' },
    owner.accessToken,
  );
  assert.equal(r.status, 200);
  const noteInvite = (await r.json()).invite;
  assert.ok(noteInvite?.token);
  assert.ok(
    (
      await (await request(`/api/notes/${collabId}/invites`, undefined, owner.accessToken)).json()
    ).some((i) => i.id === noteInvite.id),
  );
  assert.equal(
    (await request(`/api/notes/${collabId}/invites`, undefined, other.accessToken)).status,
    403,
  );
  const inviteInfo = await (await request(`/api/invites/${noteInvite.token}`)).json();
  assert.equal(inviteInfo.email, 'newbie@example.test');
  assert.ok(inviteInfo.noteTitle);
  r = await request('/api/auth/register', {
    name: 'Новичок',
    email: 'newbie@example.test',
    password: 'newbie-password-2026',
    invite: noteInvite.token,
  });
  assert.equal(r.status, 200);
  const newbie = await r.json();
  assert.ok(
    (await (await request('/api/collaboration', undefined, newbie.accessToken)).json()).notes.some(
      (n) => n.note.id === collabId && !n.pending && n.role === 'reader',
    ),
  );
  assert.equal((await request(`/api/invites/${noteInvite.token}`)).status, 410);
  // Режим «по приглашениям»: без ссылки нельзя, ссылки выдаёт администратор.
  const setMode = (mode) =>
    request('/api/admin/registration', { mode }, owner.accessToken, undefined, 'PUT');
  assert.equal((await setMode('invite')).status, 200);
  assert.equal((await (await request('/api/setup')).json()).registration, 'invite');
  assert.equal(
    (
      await request('/api/auth/register', {
        name: 'Без ссылки',
        email: 'nolink@example.test',
        password: 'nolink-password-2026',
      })
    ).status,
    403,
  );
  assert.equal((await request('/api/admin/invites', {}, other.accessToken)).status, 403);
  r = await request('/api/admin/invites', { email: '' }, owner.accessToken);
  assert.equal(r.status, 200);
  const adminInvite = await r.json();
  assert.ok(
    (await (await request('/api/admin/invites', undefined, owner.accessToken)).json()).some(
      (i) => i.id === adminInvite.id,
    ),
  );
  assert.equal((await setMode('closed')).status, 200);
  assert.equal((await request(`/api/invites/${adminInvite.token}`)).status, 410);
  assert.equal((await setMode('invite')).status, 200);
  assert.equal((await request(`/api/invites/${adminInvite.token}`)).status, 200);
  r = await request('/api/auth/register', {
    name: 'По ссылке',
    email: 'invited@example.test',
    password: 'invited-password-2026',
    invite: adminInvite.token,
  });
  assert.equal(r.status, 200);
  assert.equal((await request(`/api/invites/${adminInvite.token}`)).status, 410);
  r = await request('/api/admin/invites', { email: 'revoked@example.test' }, owner.accessToken);
  const revokedInvite = await r.json();
  assert.equal(
    (
      await request(
        `/api/invites/${revokedInvite.id}`,
        undefined,
        other.accessToken,
        undefined,
        'DELETE',
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await request(
        `/api/invites/${revokedInvite.id}`,
        undefined,
        owner.accessToken,
        undefined,
        'DELETE',
      )
    ).status,
    200,
  );
  assert.equal((await request(`/api/invites/${revokedInvite.token}`)).status, 410);
  assert.equal((await setMode('open')).status, 200);
  console.log('✓ Регистрация по приглашению: ссылка в заметку, режим «по приглашениям», отзыв');

  // Гости: персональная ссылка + PIN, лимит устройств, роль, блокировка PIN, отзыв.
  const guestsUrl = `/api/notes/${collabId}/guests`;
  const guestInput = { role: 'editor', pin: '246810', expiresInDays: 7, maxDevices: 1 };
  assert.equal(
    (await request(guestsUrl, { ...guestInput, pin: '12345' }, owner.accessToken)).status,
    400,
  );
  assert.equal((await request(guestsUrl, guestInput, other.accessToken)).status, 403);
  r = await request(guestsUrl, { ...guestInput, label: 'Дима' }, owner.accessToken);
  const guestLinkText = await r.text();
  assert.equal(r.status, 200, guestLinkText);
  const guestLink = JSON.parse(guestLinkText);
  assert.equal(guestLink.pin_hash, undefined);
  const gUrl = `/api/guest/${guestLink.token}`;
  const guestInfo = await (await request(gUrl)).json();
  assert.equal(guestInfo.role, 'editor');
  assert.equal(guestInfo.title, undefined, 'название заметки не раскрывается до PIN');
  assert.equal((await request(`${gUrl}/login`, { name: 'Дима', pin: '000000' })).status, 401);
  r = await request(`${gUrl}/login`, { name: 'Дима', pin: '246810' });
  assert.equal(r.status, 200);
  const guest = await r.json();
  const guestCookie = r.headers.get('set-cookie').split(';')[0];
  assert.equal(guest.note.id, collabId);
  assert.equal((await request('/api/tasks', undefined, guest.accessToken)).status, 401);
  assert.equal(
    (await request(`${gUrl}/login`, { name: 'Второй', pin: '246810' })).status,
    403,
    'лимит устройств',
  );
  assert.equal((await request(`${gUrl}/refresh`, {}, undefined, guestCookie)).status, 200);
  const guestClient = connect(`note:${collabId}`, guest.accessToken);
  await waitFor(() => guestClient.provider.isSynced, 'гость подключился');
  const gp = new Y.XmlElement('paragraph'),
    gt = new Y.XmlText();
  gt.insert(0, 'Правка гостя');
  gp.insert(0, [gt]);
  guestClient.doc.getXmlFragment('content').push([gp]);
  await waitFor(
    () => extractDocument(co.doc).plainText.includes('Правка гостя'),
    'гость меняет текст владельца',
  );
  const guestSpace = connect(`space:${owner.user.id}`, guest.accessToken);
  let guestSpaceDenied = false;
  guestSpace.provider.on('authenticationFailed', () => {
    guestSpaceDenied = true;
  });
  await waitFor(() => guestSpaceDenied, 'гость не открывает пространство владельца');
  assert.equal(
    (
      await request(
        `/api/guests/${guestLink.id}`,
        { role: 'reader' },
        owner.accessToken,
        undefined,
        'PATCH',
      )
    ).status,
    200,
  );
  await waitFor(() => guestClient.provider.authorizedScope === 'readonly', 'гость стал читателем');
  let guestList = await (await request(guestsUrl, undefined, owner.accessToken)).json();
  assert.equal(guestList[0].devices[0].name, 'Дима');
  assert.deepEqual(
    (
      await (await request('/api/collaboration', undefined, owner.accessToken)).json()
    ).owned.includes(collabId),
    true,
  );
  let guestRevoked = false;
  guestClient.provider.on('authenticationFailed', () => {
    guestRevoked = true;
  });
  assert.equal(
    (
      await request(
        `/api/guests/${guestLink.id}`,
        undefined,
        owner.accessToken,
        undefined,
        'DELETE',
      )
    ).status,
    200,
  );
  await waitFor(() => guestRevoked, 'отзыв ссылки отключает гостя');
  assert.equal((await request(`${gUrl}/refresh`, {}, undefined, guestCookie)).status, 410);
  // пять неверных PIN блокируют ссылку на час, владелец может снять блокировку
  r = await request(guestsUrl, { ...guestInput, maxDevices: null }, owner.accessToken);
  const lockLink = await r.json();
  const lockUrl = `/api/guest/${lockLink.token}/login`;
  for (let i = 0; i < 4; i++)
    assert.equal((await request(lockUrl, { name: 'Взломщик', pin: `00000${i}` })).status, 401);
  assert.equal((await request(lockUrl, { name: 'Взломщик', pin: '000009' })).status, 423);
  assert.equal((await request(lockUrl, { name: 'Гость', pin: '246810' })).status, 423);
  guestList = await (await request(guestsUrl, undefined, owner.accessToken)).json();
  assert.ok(guestList.find((l) => l.id === lockLink.id).locked_until);
  assert.equal(
    (
      await request(
        `/api/guests/${lockLink.id}`,
        { unlock: true },
        owner.accessToken,
        undefined,
        'PATCH',
      )
    ).status,
    200,
  );
  assert.equal((await request(lockUrl, { name: 'Гость', pin: '246810' })).status, 200);
  console.log('✓ Гости: ссылка + PIN, лимит устройств, роль, блокировка после 5 ошибок, отзыв');

  // Админка: блокировка и удаление пользователя.
  const victim = { name: 'Временный', email: 'temp@example.test', password: 'temp-password-2026' };
  r = await request('/api/admin/users', { ...victim, role: 'user' }, owner.accessToken);
  assert.equal(r.status, 200);
  const victimId = (await r.json()).id;
  r = await request('/api/auth/login', { email: victim.email, password: victim.password });
  const victimAuth = await r.json();
  const victimCookie = r.headers.get('set-cookie').split(';')[0];
  const victimNote = randomUUID();
  const vn = connect(`note:${victimNote}`, victimAuth.accessToken);
  await waitFor(() => vn.provider.isSynced, 'заметка удаляемого пользователя');
  const vp = new Y.XmlElement('paragraph'),
    vt = new Y.XmlText();
  vt.insert(0, 'Будет удалено');
  vp.insert(0, [vt]);
  vn.doc.getXmlFragment('content').insert(0, [vp]);
  await waitFor(
    async () =>
      (await request(`/api/notes/${victimNote}/versions`, undefined, victimAuth.accessToken))
        .status === 200,
    'заметка сохранена на сервере',
  );
  const patchUser = (id, body) =>
    request(`/api/admin/users/${id}`, body, owner.accessToken, undefined, 'PATCH');
  let victimDropped = false;
  vn.provider.on('authenticationFailed', () => {
    victimDropped = true;
  });
  assert.equal((await patchUser(owner.user.id, { blocked: true })).status, 400);
  assert.equal((await patchUser(victimId, { blocked: true })).status, 200);
  assert.equal((await request('/api/auth/refresh', {}, undefined, victimCookie)).status, 401);
  assert.equal(
    (await request('/api/auth/login', { email: victim.email, password: victim.password })).status,
    403,
  );
  await waitFor(() => victimDropped, 'заблокированный пользователь отключён');
  const users = await (await request('/api/admin/users', undefined, owner.accessToken)).json();
  assert.ok(users.users.find((u) => u.id === victimId).blocked_at);
  assert.equal((await patchUser(victimId, { blocked: false })).status, 200);
  assert.equal(
    (await request('/api/auth/login', { email: victim.email, password: victim.password })).status,
    200,
  );
  const removeUser = (id, confirm) =>
    request(`/api/admin/users/${id}`, { confirm }, owner.accessToken, undefined, 'DELETE');
  assert.equal((await removeUser(victimId, 'wrong@example.test')).status, 400);
  assert.equal((await removeUser(owner.user.id, setup.email)).status, 400);
  r = await removeUser(victimId, victim.email);
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal((await r.json()).notes, 1);
  vn.provider.destroy();
  vn.socket.destroy();
  const afterDelete = new SQLite(path.join(data, 'selfnote.sqlite'), { readonly: true });
  assert.equal(afterDelete.prepare('select id from users where id = ?').get(victimId), undefined);
  assert.equal(
    afterDelete.prepare('select name from yjs_documents where owner_id = ?').get(victimId),
    undefined,
  );
  assert.ok(
    afterDelete.prepare('select note_id from purged_notes where note_id = ?').get(victimNote),
  );
  afterDelete.close();
  assert.equal(
    (await request('/api/auth/login', { email: victim.email, password: victim.password })).status,
    401,
  );
  console.log('✓ Админка: блокировка, разблокировка, удаление пользователя с данными');

  spaceLive.doc.transact(() => {
    spaceLive.doc.getMap('purged').set(collabId, true);
    spaceLive.doc.getMap('notes').delete(collabId);
  });
  await waitFor(
    async () =>
      !(
        await (await request('/api/collaboration', undefined, invitedReader.accessToken)).json()
      ).notes.some((n) => n.note.id === collabId),
    'удаление общей заметки',
  );
  console.log(
    '✓ Совместный доступ: приглашения, роли, офлайн-слияние, заголовок, история, вложения, отзыв, корзина и удаление',
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

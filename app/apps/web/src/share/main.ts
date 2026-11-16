/**
 * Публичная страница /s/<token>. Обычную заметку сервер уже отрисовал — здесь только
 * скрытый текст и тема. Заметку под паролем расшифровывает браузер ключом из #фрагмента.
 */
import '@fontsource/golos-text/400.css';
import '@fontsource/golos-text/600.css';
import '@fontsource/golos-text/700.css';
import './share.css';
import * as Y from 'yjs';
import {
  localDate,
  parseEnvelope,
  renderDocument,
  shareKeyNeedsPassword,
  unseal,
  unwrapShareKey,
  WrongPasswordError,
} from '@selfnote/shared';

const body = document.body;
const token = body.dataset.token ?? '';

document.addEventListener('click', (e) => {
  const spoiler = (e.target as Element).closest('[data-spoiler]');
  if (spoiler) spoiler.classList.toggle('revealed');
});
document.addEventListener('keydown', (e) => {
  const target = e.target as Element;
  if ((e.key === 'Enter' || e.key === ' ') && target.matches('[data-spoiler]')) {
    e.preventDefault();
    target.classList.toggle('revealed');
  }
});

const main = document.querySelector('main.share')!;
function show(html: string) {
  main.querySelector('.share-note, .share-lock')?.remove();
  main.querySelector('.share-head')!.insertAdjacentHTML('afterend', html);
}
function escape(value: string) {
  const div = document.createElement('div');
  div.textContent = value;
  return div.innerHTML;
}
function message(title: string, text: string) {
  show(`<div class="share-lock"><h1>${escape(title)}</h1><p>${escape(text)}</p></div>`);
}
/** Форма пароля ссылки; submit — вызывает onPassword. */
function passwordForm(error = '') {
  show(`<form class="share-lock">
    <span class="share-lock-icon" aria-hidden="true"></span>
    <h1>Заметка зашифрована</h1>
    <p>Введите пароль, который вам сообщил автор ссылки.</p>
    <label>Пароль<input type="password" name="password" autocomplete="current-password" required autofocus></label>
    <p class="share-error" role="alert">${escape(error)}</p>
    <button type="submit">Открыть заметку</button>
  </form>`);
  const form = main.querySelector('form')!;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const button = form.querySelector('button')!;
    button.disabled = true;
    button.textContent = 'Проверяем…';
    void openEncrypted(new FormData(form).get('password') as string);
  });
}
async function openEncrypted(password?: string) {
  const fragment = decodeURIComponent(location.hash.slice(1));
  if (!fragment)
    return message(
      'Ссылка неполная',
      'В адресе нет ключа расшифровки — попросите автора прислать ссылку целиком.',
    );
  const needsPassword = shareKeyNeedsPassword(fragment) || body.dataset.locked === '1';
  if (needsPassword && password === undefined) return passwordForm();
  try {
    if (password !== undefined && body.dataset.locked === '1') {
      const response = await fetch(`/s/${token}/unlock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
        credentials: 'same-origin',
      });
      if (response.status === 401) throw new WrongPasswordError();
      if (!response.ok)
        throw new Error((await response.json().catch(() => ({}))).message || 'Ссылка недоступна');
      body.dataset.locked = '0';
    }
    const key = await unwrapShareKey(fragment, password);
    const response = await fetch(`/s/${token}/data`, { credentials: 'same-origin' });
    if (!response.ok) throw new Error('Ссылка недоступна');
    const data = (await response.json()) as { payload: string; title: string; updated_at: string };
    const state = await unseal(key, parseEnvelope(data.payload));
    const doc = new Y.Doc();
    Y.applyUpdate(doc, state);
    const rendered = renderDocument(doc.getXmlFragment('content'), {
      today: localDate(),
      image: (src) =>
        src.startsWith('/api/attachments/') ? `/s/${token}/img/${src.split('/')[3]}` : null,
    });
    const title = String(doc.getMap('secure').get('title') || data.title || 'Без названия');
    document.title = `${title} — SelfNote`;
    const updated = new Date(data.updated_at).toLocaleDateString('ru', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
    show(`<article class="share-note">
      <h1 class="share-title">${escape(title)}</h1>
      <p class="share-meta">Обновлено ${escape(updated)}</p>
      <div class="share-body note-body">${rendered.html || '<p class="share-status">Заметка пока пустая.</p>'}</div>
    </article>`);
    doc.destroy();
  } catch (error) {
    if (error instanceof WrongPasswordError) passwordForm('Неверный пароль');
    else message('Не удалось открыть заметку', (error as Error).message);
  }
}
if (body.dataset.encrypted === '1') void openEncrypted();

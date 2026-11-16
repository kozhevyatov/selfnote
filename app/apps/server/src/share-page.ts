/** HTML публичной страницы заметки /s/<token>. Рендерится сервером: превью в Telegram работает без JS. */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { escapeHtml } from '@selfnote/shared';

interface Assets {
  scripts: string[];
  styles: string[];
}
let assets: Assets | null = null;
/** Скрипт и стили страницы из манифеста Vite (точка входа src/share/main.ts). */
export async function shareAssets(webRoot: string): Promise<Assets> {
  if (assets) return assets;
  try {
    const manifest = JSON.parse(
      await readFile(path.join(webRoot, '.vite', 'manifest.json'), 'utf8'),
    ) as Record<string, { file: string; css?: string[]; isEntry?: boolean }>;
    const entry = manifest['src/share/main.ts'];
    assets = entry
      ? { scripts: [`/${entry.file}`], styles: (entry.css ?? []).map((c) => `/${c}`) }
      : { scripts: [], styles: [] };
  } catch {
    assets = { scripts: [], styles: [] };
  }
  return assets;
}

export interface PageInput {
  token: string;
  title: string;
  description: string;
  /** Абсолютный адрес картинки для превью (только без пароля). */
  image?: string | null;
  url: string;
  updatedAt?: string;
  body: string;
  encrypted: boolean;
  /** Сервер ждёт пароль ссылки. */
  locked: boolean;
  error?: string;
  assets: Assets;
}
function lockForm(token: string, error?: string, encrypted = false) {
  return `<form class="share-lock" method="post" action="/s/${escapeHtml(token)}/unlock">
  <span class="share-lock-icon" aria-hidden="true"></span>
  <h1>${encrypted ? 'Заметка зашифрована' : 'Заметка защищена паролем'}</h1>
  <p>Введите пароль, который вам сообщил автор ссылки.</p>
  <label>Пароль<input type="password" name="password" autocomplete="current-password" required autofocus></label>
  <p class="share-error" role="alert">${error ? escapeHtml(error) : ''}</p>
  <button type="submit">Открыть заметку</button>
</form>`;
}
export function sharePage(input: PageInput) {
  const title = input.title || 'Заметка';
  const og = [
    ['og:type', 'article'],
    ['og:site_name', 'SelfNote'],
    ['og:title', title],
    ['og:description', input.description],
    ['og:url', input.url],
    ...(input.image ? [['og:image', input.image]] : []),
    ['twitter:card', input.image ? 'summary_large_image' : 'summary'],
  ]
    .map(([p, c]) => `<meta property="${p}" content="${escapeHtml(c)}">`)
    .join('\n    ');
  const updated = input.updatedAt
    ? new Date(input.updatedAt).toLocaleDateString('ru', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      })
    : '';
  const content = input.locked
    ? lockForm(input.token, input.error, input.encrypted)
    : `<article class="share-note">
      <h1 class="share-title">${escapeHtml(title)}</h1>
      ${updated ? `<p class="share-meta">Обновлено ${escapeHtml(updated)}</p>` : '<p class="share-meta"></p>'}
      <div class="share-body note-body">${input.body}</div>
    </article>`;
  return `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex, nofollow">
    <meta name="referrer" content="no-referrer">
    <meta name="description" content="${escapeHtml(input.description)}">
    ${og}
    <title>${escapeHtml(title)} — SelfNote</title>
    <link rel="icon" type="image/svg+xml" href="/icon.svg">
    ${input.assets.styles.map((s) => `<link rel="stylesheet" href="${escapeHtml(s)}">`).join('\n    ')}
  </head>
  <body class="share-page" data-token="${escapeHtml(input.token)}" data-encrypted="${input.encrypted ? 1 : 0}" data-locked="${input.locked ? 1 : 0}">
    <main class="share">
      <header class="share-head"><a href="/" class="share-brand">SelfNote</a></header>
      ${content}
      <footer class="share-foot">Заметка опубликована по ссылке. Только для чтения.</footer>
    </main>
    ${input.assets.scripts.map((s) => `<script type="module" src="${escapeHtml(s)}"></script>`).join('\n    ')}
  </body>
</html>`;
}
export function unavailablePage(assets: Assets, message = 'Ссылка недоступна') {
  return `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex, nofollow">
    <title>${escapeHtml(message)} — SelfNote</title>
    <link rel="icon" type="image/svg+xml" href="/icon.svg">
    ${assets.styles.map((s) => `<link rel="stylesheet" href="${escapeHtml(s)}">`).join('\n    ')}
  </head>
  <body class="share-page">
    <main class="share">
      <header class="share-head"><a href="/" class="share-brand">SelfNote</a></header>
      <div class="share-lock">
        <h1>${escapeHtml(message)}</h1>
        <p>Автор мог отозвать ссылку, удалить заметку или срок действия ссылки закончился.</p>
      </div>
    </main>
  </body>
</html>`;
}
export const SHARE_CSP =
  "default-src 'none'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

/**
 * Где запущен веб-клиент. В браузере всё относительно текущего адреса.
 * В десктоп-приложении (Tauri, сборка `vite build --mode desktop`) интерфейс
 * лежит внутри приложения, а сервер выбирается при первом запуске: запросы идут
 * на его адрес, cookie не используются — refresh-токен хранится на устройстве
 * и передаётся в теле запроса (заголовок X-SelfNote-Client: app).
 */
export const isDesktop = import.meta.env.MODE === 'desktop';

const SERVER_KEY = 'selfnote-server';
const REFRESH_KEY = 'selfnote-refresh';

/** Адрес сервера десктоп-приложения, например https://note.example.ru (без слэша). */
export function serverOrigin(): string {
  if (!isDesktop) return '';
  try {
    return localStorage.getItem(SERVER_KEY) ?? '';
  } catch {
    return '';
  }
}
export function setServerOrigin(value: string | null) {
  if (value) localStorage.setItem(SERVER_KEY, value);
  else localStorage.removeItem(SERVER_KEY);
}

/** Путь API → полный адрес: в браузере как есть, в приложении — с адресом сервера. */
export function apiUrl(path: string): string {
  return isDesktop && path.startsWith('/') ? serverOrigin() + path : path;
}

/** Адрес для ссылок, которые увидят другие люди (публичные, гостевые, приглашения). */
export function publicOrigin(): string {
  return isDesktop ? serverOrigin() : location.origin;
}

export function socketUrl(): string {
  if (isDesktop) return serverOrigin().replace(/^http/i, 'ws') + '/collab';
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/collab`;
}

export function refreshToken(): string {
  return (isDesktop && localStorage.getItem(REFRESH_KEY)) || '';
}
export function setRefreshToken(value: string | null) {
  if (!isDesktop) return;
  if (value) localStorage.setItem(REFRESH_KEY, value);
  else localStorage.removeItem(REFRESH_KEY);
}

/** «note.example.ru» → «https://note.example.ru»; без завершающего слэша. */
export function normalizeServer(input: string): string {
  let value = input.trim().replace(/\/+$/, '');
  if (!value) throw new Error('Укажите адрес сервера');
  if (!/^https?:\/\//i.test(value)) value = 'https://' + value;
  if (!/^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/i.test(value))
    throw new Error('Адрес сервера выглядит неправильно');
  return value.replace(/^https?/i, (m) => m.toLowerCase());
}

/** Проверяет, что по адресу отвечает настроенный SelfNote. */
export async function checkServer(server: string) {
  const get = async (path: string) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(server + path, { signal: controller.signal });
      return { ok: response.ok, data: await response.json().catch(() => null) };
    } catch {
      throw new Error('Сервер недоступен. Проверьте адрес и подключение к сети');
    } finally {
      clearTimeout(timer);
    }
  };
  const health = await get('/api/health');
  if (!health.ok || !(health.data as { ok?: boolean } | null)?.ok)
    throw new Error('По этому адресу не найден сервер SelfNote');
  const setup = await get('/api/setup');
  if ((setup.data as { required?: boolean } | null)?.required)
    throw new Error('Сервер ещё не настроен: откройте его в браузере и пройдите мастер');
}

/**
 * Десктоп: внешние ссылки открываются в браузере по умолчанию, а не внутри окна
 * приложения (плагин opener в Tauri).
 */
export function openExternalLinks() {
  if (!isDesktop) return;
  const tauri = (
    window as unknown as {
      __TAURI_INTERNALS__?: { invoke: (cmd: string, args: unknown) => Promise<unknown> };
    }
  ).__TAURI_INTERNALS__;
  if (!tauri) return;
  const open = (url: string) => void tauri.invoke('plugin:opener|open_url', { url });
  document.addEventListener(
    'click',
    (e) => {
      const link = (e.target as Element | null)?.closest?.('a[href]');
      if (!link) return;
      const href = (link as HTMLAnchorElement).href;
      if (!/^(https?:|mailto:|tel:)/i.test(href)) return;
      e.preventDefault();
      open(href);
    },
    true,
  );
  window.open = ((url?: string | URL) => {
    if (url && /^(https?:|mailto:)/i.test(String(url))) open(String(url));
    return null;
  }) as typeof window.open;
}

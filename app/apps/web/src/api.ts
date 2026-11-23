export interface User {
  id: string;
  name: string;
  email: string;
  /** admin — может управлять резервными копиями. */
  role?: string;
}
import { apiUrl, isDesktop, refreshToken, setRefreshToken } from './platform';
let accessToken = '';
let refreshing: Promise<{ accessToken: string; user: User }> | undefined;
export function setToken(token: string) {
  accessToken = token;
}
export async function refresh() {
  if (!refreshing)
    refreshing = (
      isDesktop
        ? refreshToken()
          ? fetch(apiUrl('/api/auth/refresh'), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-SelfNote-Client': 'app' },
              body: JSON.stringify({ refreshToken: refreshToken() }),
              credentials: 'omit',
            })
          : Promise.resolve(new Response(null, { status: 401 }))
        : fetch('/api/auth/refresh', { method: 'POST', credentials: 'same-origin' })
    )
      .then(async (r) => {
        if (isDesktop && r.status === 401) setRefreshToken(null);
        if (!r.ok) throw new Error('Войдите в аккаунт');
        const data = await r.json();
        setToken(data.accessToken);
        return data as { accessToken: string; user: User };
      })
      .finally(() => {
        refreshing = undefined;
      });
  return refreshing;
}
export async function token() {
  if (!accessToken) await refresh();
  return accessToken;
}
export async function api<T>(url: string, options: RequestInit = {}, retry = true): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body != null && !(options.body instanceof FormData))
    headers.set('Content-Type', 'application/json');
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
  if (isDesktop) {
    headers.set('X-SelfNote-Client', 'app');
    if (url === '/api/auth/logout' && refreshToken()) {
      headers.set('Content-Type', 'application/json');
      options = { ...options, body: JSON.stringify({ refreshToken: refreshToken() }) };
      setRefreshToken(null);
    }
  }
  const response = await fetch(apiUrl(url), {
    ...options,
    headers,
    credentials: isDesktop ? 'omit' : 'same-origin',
  });
  if (
    response.status === 401 &&
    retry &&
    !url.startsWith('/api/auth/') &&
    !url.startsWith('/api/setup')
  ) {
    await refresh();
    return api(url, options, false);
  }
  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: 'Ошибка соединения' }));
    throw Object.assign(new Error(error.message || 'Не удалось выполнить запрос'), {
      status: response.status,
      data: error,
    });
  }
  const data = await response.json();
  // вход, регистрация, мастер: в приложении сервер отдаёт refresh-токен в теле
  if (isDesktop && data && typeof data.refreshToken === 'string') {
    setRefreshToken(data.refreshToken);
    delete data.refreshToken;
  }
  return data as T;
}

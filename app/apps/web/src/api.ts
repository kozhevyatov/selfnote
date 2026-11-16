export interface User {
  id: string;
  name: string;
  email: string;
  /** admin — может управлять резервными копиями. */
  role?: string;
}
let accessToken = '';
let refreshing: Promise<{ accessToken: string; user: User }> | undefined;
export function setToken(token: string) {
  accessToken = token;
}
export async function refresh() {
  if (!refreshing)
    refreshing = fetch('/api/auth/refresh', { method: 'POST', credentials: 'same-origin' })
      .then(async (r) => {
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
  if (!(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
  const response = await fetch(url, { ...options, headers, credentials: 'same-origin' });
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
    throw new Error(error.message || 'Не удалось выполнить запрос');
  }
  return response.json();
}

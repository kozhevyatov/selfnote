/**
 * Аккаунт на устройстве: адрес сервера, пользователь и refresh-токен (в защищённом
 * хранилище). Access-токен живёт 15 минут только в памяти.
 */
import * as SecureStore from 'expo-secure-store';

export interface User {
  id: string;
  name: string;
  email: string;
  role?: string;
}
export interface Account {
  server: string;
  user: User;
  refreshToken: string;
}
const ACCOUNT_KEY = 'selfnote.account';
const LAST_KEY = 'selfnote.last';
const APP_HEADERS = { 'Content-Type': 'application/json', 'X-SelfNote-Client': 'app' };
const TOKEN_TTL = 12 * 60 * 1000; // сервер выдаёт на 15 минут, обновляем заранее

let account: Account | null = null;
let accessToken = '';
let issuedAt = 0;
let refreshing: Promise<string> | undefined;
const listeners = new Set<(account: Account | null) => void>();

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** «note.example.ru» → «https://note.example.ru»; без завершающего слэша. */
export function normalizeServer(input: string): string {
  let value = input.trim().replace(/\/+$/, '');
  if (!value) throw new Error('Укажите адрес сервера');
  if (!/^https?:\/\//i.test(value)) value = 'https://' + value;
  if (!/^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/i.test(value))
    throw new Error('Адрес сервера выглядит неправильно');
  return value.replace(/^HTTP/i, (m) => m.toLowerCase());
}
export function socketUrl(server: string) {
  return server.replace(/^http/i, 'ws') + '/collab';
}

async function request(url: string, init: RequestInit = {}, timeout = 15000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch {
    throw new ApiError('Сервер недоступен. Проверьте адрес и подключение к сети', 0);
  } finally {
    clearTimeout(timer);
  }
}
async function failure(response: Response): Promise<ApiError> {
  const data = (await response.json().catch(() => null)) as { message?: string } | null;
  return new ApiError(data?.message || `Ошибка сервера (${response.status})`, response.status);
}

export function currentAccount() {
  return account;
}
export function onAccountChange(listener: (account: Account | null) => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
function setAccount(next: Account | null) {
  account = next;
  if (!next) {
    accessToken = '';
    issuedAt = 0;
  }
  for (const listener of listeners) listener(next);
}

export async function loadAccount(): Promise<Account | null> {
  try {
    const raw = await SecureStore.getItemAsync(ACCOUNT_KEY);
    account = raw ? (JSON.parse(raw) as Account) : null;
  } catch {
    account = null;
  }
  return account;
}
/** Адрес и почта последнего входа — чтобы не вводить их заново. */
export async function lastLogin(): Promise<{ server: string; email: string } | null> {
  const raw = await SecureStore.getItemAsync(LAST_KEY).catch(() => null);
  return raw ? JSON.parse(raw) : null;
}

/** Проверяет, что по адресу отвечает SelfNote и он настроен. */
export async function checkServer(server: string) {
  const health = await request(server + '/api/health', {}, 8000);
  const data = (await health.json().catch(() => null)) as { ok?: boolean } | null;
  if (!health.ok || !data?.ok) throw new ApiError('По этому адресу не найден сервер SelfNote', 0);
  const setup = await request(server + '/api/setup', {}, 8000);
  const state = (await setup.json().catch(() => null)) as { required?: boolean } | null;
  if (state?.required)
    throw new ApiError('Сервер ещё не настроен: откройте его в браузере и пройдите мастер', 0);
}

export async function login(serverInput: string, email: string, password: string) {
  const server = normalizeServer(serverInput);
  await checkServer(server);
  const response = await request(server + '/api/auth/login', {
    method: 'POST',
    headers: APP_HEADERS,
    body: JSON.stringify({ email: email.trim(), password }),
  });
  if (!response.ok) throw await failure(response);
  const data = (await response.json()) as { accessToken: string; refreshToken?: string; user: User };
  if (!data.refreshToken)
    throw new ApiError('Сервер устарел: обновите контейнер SelfNote до последней версии', 0);
  const next: Account = { server, user: data.user, refreshToken: data.refreshToken };
  await SecureStore.setItemAsync(ACCOUNT_KEY, JSON.stringify(next));
  await SecureStore.setItemAsync(LAST_KEY, JSON.stringify({ server, email: email.trim() }));
  accessToken = data.accessToken;
  issuedAt = Date.now();
  setAccount(next);
}

/** Новый access-токен. Сессия завершена на сервере → выходим из аккаунта на устройстве. */
export function refresh(): Promise<string> {
  const current = account;
  if (!current) return Promise.reject(new ApiError('Войдите в аккаунт', 401));
  refreshing ??= (async () => {
    const response = await request(current.server + '/api/auth/refresh', {
      method: 'POST',
      headers: APP_HEADERS,
      body: JSON.stringify({ refreshToken: current.refreshToken }),
    });
    if (response.status === 401) {
      const error = await failure(response);
      await signOutLocally();
      throw error;
    }
    if (!response.ok) throw await failure(response);
    const data = (await response.json()) as { accessToken: string; user: User };
    accessToken = data.accessToken;
    issuedAt = Date.now();
    if (JSON.stringify(data.user) !== JSON.stringify(current.user) && account === current) {
      const next = { ...current, user: data.user };
      await SecureStore.setItemAsync(ACCOUNT_KEY, JSON.stringify(next));
      setAccount(next);
    }
    return accessToken;
  })().finally(() => {
    refreshing = undefined;
  });
  return refreshing;
}
export async function token(): Promise<string> {
  if (accessToken && Date.now() - issuedAt < TOKEN_TTL) return accessToken;
  return refresh();
}

export async function api<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const current = account;
  if (!current) throw new ApiError('Войдите в аккаунт', 401);
  const headers: Record<string, string> = {
    'X-SelfNote-Client': 'app',
    Authorization: `Bearer ${await token()}`,
    ...(init.body != null && !(init.body instanceof FormData)
      ? { 'Content-Type': 'application/json' }
      : {}),
  };
  const response = await request(current.server + path, {
    ...init,
    headers: { ...headers, ...(init.headers as Record<string, string>) },
  });
  if (response.status === 401 && retry) {
    accessToken = '';
    await refresh();
    return api(path, init, false);
  }
  if (!response.ok) throw await failure(response);
  return response.json() as Promise<T>;
}

async function signOutLocally() {
  await SecureStore.deleteItemAsync(ACCOUNT_KEY).catch(() => undefined);
  setAccount(null);
}
/** Выход: закрываем сессию на сервере (если он доступен) и забываем токен. */
export async function logout() {
  const current = account;
  if (current)
    await request(
      current.server + '/api/auth/logout',
      {
        method: 'POST',
        headers: APP_HEADERS,
        body: JSON.stringify({ refreshToken: current.refreshToken }),
      },
      5000,
    ).catch(() => undefined);
  await signOutLocally();
}

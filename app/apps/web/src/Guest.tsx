import { useEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import { HocuspocusProvider, WebSocketStatus } from '@hocuspocus/provider';
import { Feather, KeyRound, LogOut, Users } from 'lucide-react';
import { GuestEditor } from './Editor';

/**
 * Гостевая страница /g/<токен>: совместное редактирование без аккаунта.
 * Гость вводит имя и PIN; сервер выдаёт cookie устройства и короткий токен для WebSocket.
 * Локальной копии нет — гостю нужна сеть.
 */
interface GuestAuth {
  accessToken: string;
  guest: { id: string; name: string };
  note: { id: string; title: string; role: 'editor' | 'reader' };
}
interface GuestInfo {
  ownerName: string;
  role: 'editor' | 'reader';
  lockedUntil: string | null;
}
class GuestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly data: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
async function call<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({ message: 'Ошибка соединения' }));
  if (!response.ok)
    throw new GuestError(data.message || 'Не удалось выполнить запрос', response.status, data);
  return data as T;
}
const NAME_KEY = 'selfnote-guest-name';
const time = (iso: string) =>
  new Date(iso).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });

export default function GuestApp({ token }: { token: string }) {
  const base = `/api/guest/${encodeURIComponent(token)}`;
  const [auth, setAuth] = useState<GuestAuth | null>(null);
  const [info, setInfo] = useState<GuestInfo | null>(null);
  const [fatal, setFatal] = useState('');
  const [checking, setChecking] = useState(true);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    document.title = 'Совместная заметка — SelfNote';
    let active = true;
    call<GuestAuth>(`${base}/refresh`, {})
      .then((result) => active && setAuth(result))
      .catch(async (error: GuestError) => {
        if (!active) return;
        if (error.status === 410) return setFatal(error.message);
        try {
          const result = await call<GuestInfo>(base);
          if (active) setInfo(result);
        } catch (e) {
          if (active) setFatal((e as Error).message);
        }
      })
      .finally(() => active && setChecking(false));
    return () => {
      active = false;
    };
  }, [base]);
  /** Соединение потеряло права: выясняем, отозвана ли ссылка или только это устройство. */
  const lost = async () => {
    try {
      setAuth(await call<GuestAuth>(`${base}/refresh`, {}));
    } catch (e) {
      const error = e as GuestError;
      setAuth(null);
      if (error.status === 401) {
        setNotice('Владелец заметки отключил это устройство. Войдите заново.');
        setInfo(await call<GuestInfo>(base).catch(() => null));
      } else setFatal(error.message);
    }
  };
  if (checking) return <div className="guest-shell empty">Открываем заметку…</div>;
  if (fatal)
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <span className="welcome-icon">
            <Feather size={28} />
          </span>
          <h1>Заметка недоступна</h1>
          <p>{fatal}</p>
        </div>
      </div>
    );
  if (!auth)
    return (
      <GuestLogin
        base={base}
        info={info}
        notice={notice}
        onLogin={(result) => {
          setNotice('');
          setAuth(result);
        }}
      />
    );
  return (
    <GuestNote
      key={auth.accessToken}
      base={base}
      auth={auth}
      onLost={() => void lost()}
      onLogout={async () => {
        await call(`${base}/logout`, {}).catch(() => undefined);
        setAuth(null);
        setInfo(await call<GuestInfo>(base).catch(() => null));
      }}
    />
  );
}

function GuestLogin({
  base,
  info,
  notice,
  onLogin,
}: {
  base: string;
  info: GuestInfo | null;
  notice: string;
  onLogin: (auth: GuestAuth) => void;
}) {
  const [name, setName] = useState(() => localStorage.getItem(NAME_KEY) ?? '');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [lockedUntil, setLockedUntil] = useState(info?.lockedUntil ?? null);
  const locked = Boolean(lockedUntil && Date.parse(lockedUntil) > Date.now());
  return (
    <div className="auth-screen">
      <form
        className="auth-card"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            const result = await call<GuestAuth>(`${base}/login`, { name: name.trim(), pin });
            localStorage.setItem(NAME_KEY, name.trim());
            onLogin(result);
          } catch (err) {
            const failure = err as GuestError;
            if (failure.status === 423 && typeof failure.data.lockedUntil === 'string')
              setLockedUntil(failure.data.lockedUntil);
            setError(failure.message);
            setPin('');
          } finally {
            setBusy(false);
          }
        }}
      >
        <span className="welcome-icon">
          <Users size={28} />
        </span>
        <h1>Совместная заметка</h1>
        <p>
          {info?.ownerName
            ? `${info.ownerName} приглашает вас ${info.role === 'reader' ? 'посмотреть' : 'поработать над'} заметк${info.role === 'reader' ? 'у' : 'ой'} в SelfNote.`
            : 'Вас пригласили к заметке в SelfNote.'}{' '}
          Аккаунт не нужен — введите своё имя и PIN, который вам передали.
        </p>
        {notice && <p className="small muted">{notice}</p>}
        <label>
          Ваше имя
          <input
            required
            autoFocus={!name}
            maxLength={60}
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Его увидят владелец и другие участники"
          />
        </label>
        <label>
          PIN
          <input
            required
            autoFocus={Boolean(name)}
            type="password"
            autoComplete="one-time-code"
            maxLength={64}
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            disabled={locked}
          />
        </label>
        {locked && lockedUntil ? (
          <p className="error" role="alert">
            Слишком много неверных PIN. Ссылка заблокирована до {time(lockedUntil)}.
          </p>
        ) : (
          error && (
            <p className="error" role="alert">
              {error}
            </p>
          )
        )}
        <button className="primary auth-submit" disabled={busy || locked || !name.trim() || !pin}>
          <KeyRound size={17} />
          {busy ? 'Проверяем…' : 'Открыть заметку'}
        </button>
      </form>
    </div>
  );
}

function GuestNote({
  base,
  auth,
  onLost,
  onLogout,
}: {
  base: string;
  auth: GuestAuth;
  onLost: () => void;
  onLogout: () => Promise<void>;
}) {
  const access = useRef({ token: auth.accessToken, at: Date.now() });
  const [synced, setSynced] = useState(false);
  const [status, setStatus] = useState('Подключение…');
  const [readOnly, setReadOnly] = useState(auth.note.role === 'reader');
  const [names, setNames] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const lostRef = useRef(onLost);
  lostRef.current = onLost;
  /** Действующий токен: обновляем заранее, он живёт 15 минут. */
  const accessToken = useMemo(
    () => async () => {
      if (Date.now() - access.current.at > 10 * 60000) {
        const next = await call<GuestAuth>(`${base}/refresh`, {});
        access.current = { token: next.accessToken, at: Date.now() };
        setReadOnly(next.note.role === 'reader');
      }
      return access.current.token;
    },
    [base],
  );
  const { doc, provider } = useMemo(() => {
    const doc = new Y.Doc();
    const provider = new HocuspocusProvider({
      url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/collab`,
      name: `note:${auth.note.id}`,
      document: doc,
      token: async () => {
        // при переподключении (сменили роль, сброс) берём свежий токен
        access.current.at = 0;
        return accessToken().catch(() => '');
      },
      onSynced: () => setSynced(true),
      onStatus: ({ status }) =>
        setStatus(status === WebSocketStatus.Connected ? 'Синхронизировано' : 'Подключение…'),
      onAuthenticationFailed: () => lostRef.current(),
    });
    return { doc, provider };
  }, [auth.note.id, accessToken]);
  useEffect(
    () => () => {
      provider.destroy();
      doc.destroy();
    },
    [provider, doc],
  );
  useEffect(() => {
    const update = () => {
      const scope = provider.authorizedScope;
      if (scope) setReadOnly(scope === 'readonly');
    };
    provider.on('authenticated', update);
    return () => {
      provider.off('authenticated', update);
    };
  }, [provider]);
  useEffect(() => {
    const awareness = provider.awareness;
    if (!awareness) return;
    awareness.setLocalStateField('user', {
      id: `guest:${auth.guest.id}`,
      name: `${auth.guest.name} (гость)`,
    });
    const update = () => {
      const users = new Map<string, string>();
      for (const state of awareness.getStates().values()) {
        const user = state.user;
        if (user && user.id !== `guest:${auth.guest.id}` && typeof user.name === 'string')
          users.set(String(user.id), user.name.slice(0, 120));
      }
      setNames([...users.values()]);
    };
    awareness.on('change', update);
    update();
    return () => awareness.off('change', update);
  }, [provider, auth.guest]);
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(''), 4000);
    return () => clearTimeout(timer);
  }, [message]);
  const loadImage = useMemo(
    () => async (src: string) => {
      const match = /^\/api\/attachments\/([a-f0-9]{64})/.exec(src);
      if (!match) throw new Error('Изображение ещё не синхронизировано');
      const response = await fetch(`${base}/img/${match[1]}`, {
        headers: { Authorization: `Bearer ${await accessToken()}` },
      });
      if (!response.ok) throw new Error('Изображение недоступно');
      return URL.createObjectURL(await response.blob());
    },
    [base, accessToken],
  );
  return (
    <div className="guest-shell">
      <header className="guest-header">
        <span className="guest-brand">
          <Feather size={20} />
          SelfNote
        </span>
        <span className="small muted">
          {auth.guest.name} · {readOnly ? 'только чтение' : 'можно редактировать'} · {status}
        </span>
        <button
          className="icon-button"
          aria-label="Выйти"
          title="Выйти на этом устройстве"
          onClick={() => void onLogout()}
        >
          <LogOut size={18} />
        </button>
      </header>
      {names.length > 0 && (
        <span className="note-presence">
          <Users size={14} />
          Сейчас в заметке: {names.join(', ')}
        </span>
      )}
      <main className="guest-main editor-scroll">
        {synced ? (
          <GuestEditor doc={doc} editable={!readOnly} loadImage={loadImage} toast={setMessage} />
        ) : (
          <div className="empty">Загружаем заметку…</div>
        )}
      </main>
      {message && (
        <div className="toast" role="status">
          {message}
        </div>
      )}
    </div>
  );
}

import { useState } from 'react';
import { ArrowRight, Server } from 'lucide-react';
import { Logo } from './Logo';
import {
  checkServer,
  normalizeServer,
  serverOrigin,
  setRefreshToken,
  setServerOrigin,
} from './platform';

/** Десктоп-приложение: первый запуск или смена сервера. */
export function ServerSetup() {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="auth-screen">
      <div className="auth-brand">
        <span className="brand-icon">
          <Logo size={22} />
        </span>{' '}
        SelfNote
      </div>
      <form
        className="auth-card"
        onSubmit={async (e) => {
          e.preventDefault();
          setError('');
          setBusy(true);
          try {
            const server = normalizeServer(String(new FormData(e.currentTarget).get('server')));
            await checkServer(server);
            if (server !== serverOrigin()) {
              setRefreshToken(null);
              localStorage.removeItem('selfnote-user');
            }
            setServerOrigin(server);
            location.reload();
          } catch (err) {
            setError((err as Error).message);
            setBusy(false);
          }
        }}
      >
        <span className="welcome-icon">
          <Server size={28} />
        </span>
        <h1>Подключение к серверу</h1>
        <p>Укажите адрес вашего SelfNote — тот же, что открываете в браузере.</p>
        <label>
          Адрес сервера
          <input
            name="server"
            required
            autoFocus
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="note.example.ru"
            defaultValue={serverOrigin().replace(/^https:\/\//, '')}
          />
        </label>
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <button className="primary auth-submit" disabled={busy}>
          {busy ? 'Проверяем…' : 'Продолжить'}
          <ArrowRight size={18} />
        </button>
      </form>
    </div>
  );
}

/** Сбросить адрес сервера — при следующем показе откроется экран подключения. */
export function changeServer() {
  setServerOrigin(null);
  location.reload();
}

import { useEffect, useState } from 'react';
import { ArrowRight, Database, ShieldCheck, RotateCcw } from 'lucide-react';
import { Logo } from './Logo';
import { api, setToken, type User } from './api';
export function Auth({
  setup,
  registration,
  onLogin,
}: {
  setup: boolean;
  registration: string;
  onLogin: (user: User) => void;
}) {
  /** Ссылка-приглашение: /?invite=<токен>. */
  const [inviteToken] = useState(() => new URLSearchParams(location.search).get('invite'));
  const [invite, setInvite] = useState<{
    email: string | null;
    inviter: string;
    noteTitle: string | null;
  } | null>(null);
  const [register, setRegister] = useState(false);
  useEffect(() => {
    if (!inviteToken || setup) return;
    api<NonNullable<typeof invite>>(`/api/invites/${encodeURIComponent(inviteToken)}`)
      .then((value) => {
        setInvite(value);
        setRegister(true);
      })
      .catch((err) => setError((err as Error).message));
  }, [inviteToken, setup]);
  const [database, setDatabase] = useState('sqlite');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  /** Мастер: восстановить сервер из резервной копии вместо создания нового пространства. */
  const [restore, setRestore] = useState(false);
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
          const form = new FormData(e.currentTarget);
          const databaseConfig =
            database === 'sqlite'
              ? { type: 'sqlite' }
              : {
                  type: 'mariadb',
                  host: form.get('host'),
                  port: Number(form.get('port')),
                  database: form.get('database'),
                  user: form.get('user'),
                  password: form.get('dbPassword'),
                };
          if (setup && restore) {
            try {
              const upload = new FormData();
              upload.append('database', JSON.stringify(databaseConfig));
              upload.append('file', form.get('backup') as File);
              await api('/api/setup/restore', { method: 'POST', body: upload });
              alert('Данные восстановлены. Войдите с прежними почтой и паролем.');
              location.reload();
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
            return;
          }
          const body: Record<string, unknown> = {
            email: form.get('email'),
            password: form.get('password'),
            name: form.get('name'),
          };
          if (register && invite && inviteToken) body.invite = inviteToken;
          if (setup) {
            body.registration = form.get('registration');
            body.database = databaseConfig;
          }
          try {
            const result = await api<{ accessToken: string; user: User }>(
              setup ? '/api/setup' : register ? '/api/auth/register' : '/api/auth/login',
              { method: 'POST', body: JSON.stringify(body) },
            );
            setToken(result.accessToken);
            if (inviteToken) history.replaceState(null, '', location.pathname);
            onLogin(result.user);
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <span className="welcome-icon">
          {setup ? <Database size={28} /> : <Logo size={28} />}
        </span>
        <h1>
          {setup
            ? restore
              ? 'Восстановление из копии'
              : 'Ваше пространство для мыслей'
            : register
              ? 'Создать аккаунт'
              : 'С возвращением'}
        </h1>
        <p>
          {setup
            ? restore
              ? 'Загрузите файл резервной копии SelfNote и выберите, где хранить данные. Аккаунты и заметки вернутся из копии.'
              : 'Настройте SelfNote один раз — и всё готово. Заметки останутся на вашем сервере.'
            : invite && register
              ? `${invite.inviter || 'Владелец сервиса'} приглашает вас в SelfNote${
                  invite.noteTitle ? ` — к заметке «${invite.noteTitle}»` : ''
                }. Создайте аккаунт, чтобы продолжить.`
              : 'Заметки, планы и маленькие большие идеи — в одном месте.'}
        </p>
        {setup && restore && (
          <label>
            Файл резервной копии (.zip)
            <input name="backup" type="file" accept=".zip" required />
          </label>
        )}
        {((setup && !restore) || register) && (
          <label>
            Ваше имя
            <input
              name="name"
              autoComplete="name"
              required
              maxLength={120}
              placeholder="Как к вам обращаться"
            />
          </label>
        )}
        {!(setup && restore) && (
          <>
            <label>
              Электронная почта
              <input
                name="email"
                type="email"
                autoComplete="username"
                required
                placeholder="name@example.ru"
                key={register && invite?.email ? 'invite-email' : 'email'}
                defaultValue={register && invite?.email ? invite.email : undefined}
                readOnly={!!(register && invite?.email)}
              />
            </label>
            <label>
              Пароль
              <input
                name="password"
                type="password"
                autoComplete={setup || register ? 'new-password' : 'current-password'}
                required
                minLength={10}
                maxLength={256}
                placeholder="Не меньше 10 символов"
              />
            </label>
          </>
        )}
        {setup && (
          <>
            <fieldset>
              <legend>Хранение данных</legend>
              <div className="segmented">
                <button
                  type="button"
                  className={database === 'sqlite' ? 'selected' : ''}
                  onClick={() => setDatabase('sqlite')}
                >
                  SQLite
                </button>
                <button
                  type="button"
                  className={database === 'mariadb' ? 'selected' : ''}
                  onClick={() => setDatabase('mariadb')}
                >
                  MariaDB
                </button>
              </div>
              <p className="small">
                {database === 'sqlite'
                  ? 'Простой запуск. База хранится файлом в папке data.'
                  : 'Подключение к вашей существующей базе MariaDB.'}
              </p>
              {database === 'mariadb' && (
                <div className="db-fields">
                  <label>
                    Хост
                    <input name="host" defaultValue="db" required />
                  </label>
                  <label>
                    Порт
                    <input
                      name="port"
                      type="number"
                      defaultValue={3306}
                      required
                      min={1}
                      max={65535}
                    />
                  </label>
                  <label>
                    База данных
                    <input name="database" defaultValue="selfnote" required />
                  </label>
                  <label>
                    Пользователь
                    <input name="user" defaultValue="selfnote" required />
                  </label>
                  <label className="full">
                    Пароль БД
                    <input name="dbPassword" type="password" autoComplete="off" />
                  </label>
                </div>
              )}
            </fieldset>
            {!restore && (
              <label>
                Регистрация
                <select name="registration" defaultValue="closed">
                  <option value="closed">Закрыта — только мой аккаунт</option>
                  <option value="open">Открыта — любой может зарегистрироваться</option>
                  <option value="invite">По приглашению — по ссылкам, которые вы выдаёте</option>
                </select>
              </label>
            )}
          </>
        )}
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <button className="primary auth-submit" disabled={busy}>
          {busy
            ? 'Подождите…'
            : setup
              ? restore
                ? 'Восстановить'
                : 'Создать пространство'
              : register
                ? 'Зарегистрироваться'
                : 'Войти'}
          <ArrowRight size={18} />
        </button>
        {setup && (
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setRestore(!restore);
              setError('');
            }}
          >
            <RotateCcw size={15} />{' '}
            {restore ? 'Настроить новое пространство' : 'Восстановить из резервной копии'}
          </button>
        )}
        {!setup && (registration === 'open' || invite) && (
          <button type="button" className="text-button" onClick={() => setRegister(!register)}>
            {register ? 'Уже есть аккаунт? Войти' : 'Создать аккаунт'}
          </button>
        )}
        <div className="auth-foot">
          <ShieldCheck size={16} /> Ваши данные — на вашем сервере
        </div>
      </form>
    </div>
  );
}

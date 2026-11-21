import { useEffect, useState, type FormEvent } from 'react';
import {
  ArrowLeft,
  BookCopy,
  Check,
  ChevronRight,
  DatabaseBackup,
  FolderInput,
  LogOut,
  Menu,
  Monitor,
  Moon,
  Palette,
  Sun,
  UserRound,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { api, type User } from './api';
import { ACCENTS, type Theme } from './theme';
import { ColorPicker } from './ColorPicker';
import { Backups, DataSettings } from './DataSettings';
import { InvitesCard } from './Invites';
import { NotebooksSettings, type NotebookActions } from './Notebooks';
import { useUI, type SettingsSection, type Workspace } from './store';

interface SectionInfo {
  id: SettingsSection;
  title: string;
  hint: string;
  Icon: LucideIcon;
  admin?: boolean;
}
const SECTIONS: SectionInfo[] = [
  { id: 'profile', title: 'Профиль', hint: 'Имя, пароль, устройства', Icon: UserRound },
  { id: 'appearance', title: 'Оформление', hint: 'Тема и цвет акцента', Icon: Palette },
  {
    id: 'notebooks',
    title: 'Записные книжки',
    hint: 'Порядок, подразделы',
    Icon: BookCopy,
  },
  {
    id: 'data',
    title: 'Экспорт и импорт',
    hint: 'Markdown, Note Station, копия',
    Icon: FolderInput,
  },
  {
    id: 'backups',
    title: 'Резервные копии',
    hint: 'Копии базы на сервере',
    Icon: DatabaseBackup,
    admin: true,
  },
  { id: 'users', title: 'Пользователи', hint: 'Аккаунты и регистрация', Icon: Users, admin: true },
];
export const settingsSections = (user: User) =>
  SECTIONS.filter((s) => !s.admin || user.role === 'admin');

export const initials = (name: string) =>
  name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((n) => n[0])
    .join('')
    .toUpperCase();

/** Вторая панель: список разделов настроек. */
export function SettingsNav({ user }: { user: User }) {
  const current = useUI((s) => s.settings);
  const openSettings = useUI((s) => s.openSettings);
  const admin = settingsSections(user).filter((s) => s.admin);
  const row = (s: SectionInfo) => (
    <button
      key={s.id}
      className={`settings-nav-item ${current === s.id ? 'selected' : ''}`}
      aria-current={current === s.id ? 'page' : undefined}
      onClick={() => openSettings(s.id)}
    >
      <span className="settings-nav-icon">
        <s.Icon size={18} />
      </span>
      <span className="settings-nav-text">
        <strong>{s.title}</strong>
        <small>{s.hint}</small>
      </span>
      <ChevronRight size={16} className="mobile-only" />
    </button>
  );
  return (
    <section className="note-list panel settings-nav">
      <header className="list-header">
        <div className="list-heading">
          <button
            className="icon-button mobile-only"
            aria-label="Открыть меню"
            onClick={() => useUI.setState({ mobile: 'nav' })}
          >
            <Menu size={20} />
          </button>
          <div>
            <h1>Настройки</h1>
          </div>
        </div>
      </header>
      <nav className="settings-nav-scroll" aria-label="Разделы настроек">
        {SECTIONS.filter((s) => !s.admin).map(row)}
        {admin.length > 0 && (
          <>
            <h2 className="settings-nav-group">Сервер</h2>
            {admin.map(row)}
          </>
        )}
      </nav>
    </section>
  );
}

/** Третья панель: содержимое выбранного раздела. */
export function SettingsPane({
  user,
  workspace,
  appearance,
  setAppearance,
  onUserChange,
  onLogout,
  notebookActions,
}: {
  user: User;
  workspace: Workspace;
  appearance: { theme: Theme; accent: string };
  setAppearance: (theme: Theme, accent: string) => void;
  onUserChange: (user: User) => void;
  onLogout: () => void;
  notebookActions: NotebookActions;
}) {
  const section = useUI((s) => s.settings);
  const toast = useUI((s) => s.toast);
  const info = settingsSections(user).find((s) => s.id === section) ?? SECTIONS[0];
  return (
    <div className="settings-scroll">
      <div className="settings-page">
        <button
          className="mobile-only text-button"
          onClick={() => useUI.setState({ mobile: 'list' })}
        >
          <ArrowLeft size={18} />К настройкам
        </button>
        <h1>{info.title}</h1>
        {info.id === 'profile' && (
          <Profile user={user} onUserChange={onUserChange} onLogout={onLogout} toast={toast} />
        )}
        {info.id === 'appearance' && (
          <Appearance appearance={appearance} setAppearance={setAppearance} />
        )}
        {info.id === 'notebooks' && (
          <NotebooksSettings workspace={workspace} actions={notebookActions} />
        )}
        {info.id === 'data' && (
          <>
            <p className="muted settings-lead">
              Выгрузка заметок в файл и перенос из других сервисов.
            </p>
            <DataSettings workspace={workspace} toast={toast} />
          </>
        )}
        {info.id === 'backups' && (
          <>
            <p className="muted settings-lead">
              Копии всей базы сервера: всех пользователей и файлов.
            </p>
            <div className="data-settings">
              <Backups toast={toast} />
            </div>
          </>
        )}
        {info.id === 'users' && <UsersSettings me={user} toast={toast} />}
      </div>
    </div>
  );
}

function Appearance({
  appearance,
  setAppearance,
}: {
  appearance: { theme: Theme; accent: string };
  setAppearance: (theme: Theme, accent: string) => void;
}) {
  const themes: [Theme, string, LucideIcon][] = [
    ['system', 'Как в системе', Monitor],
    ['light', 'Светлая', Sun],
    ['dark', 'Тёмная', Moon],
  ];
  return (
    <>
      <p className="muted settings-lead">
        Выбор сохраняется и переходит на другие ваши устройства.
      </p>
      <section className="settings-card">
        <h2>Тема</h2>
        <div className="theme-options" role="radiogroup" aria-label="Тема">
          {themes.map(([value, label, Icon]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={appearance.theme === value}
              className={appearance.theme === value ? 'selected' : ''}
              onClick={() => setAppearance(value, appearance.accent)}
            >
              <Icon size={20} />
              {label}
            </button>
          ))}
        </div>
      </section>
      <section className="settings-card">
        <h2>Цвет акцента</h2>
        <div className="settings-color">
          <div className="color-options">
            {ACCENTS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`Акцент ${c}`}
                aria-pressed={appearance.accent.toLowerCase() === c.toLowerCase()}
                style={{ background: c }}
                onClick={() => setAppearance(appearance.theme, c)}
              >
                {appearance.accent.toLowerCase() === c.toLowerCase() && <Check size={18} />}
              </button>
            ))}
            <ColorPicker
              value={appearance.accent}
              label="Свой цвет акцента"
              onChange={(color) => setAppearance(appearance.theme, color)}
            />
          </div>
        </div>
      </section>
    </>
  );
}

interface Session {
  id: string;
  created_at: string;
  expires_at: string;
  current?: boolean;
}
function Profile({
  user,
  onUserChange,
  onLogout,
  toast,
}: {
  user: User;
  onUserChange: (user: User) => void;
  onLogout: () => void;
  toast: (message: string) => void;
}) {
  const [name, setName] = useState(user.name);
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [passwords, setPasswords] = useState({ current: '', next: '', repeat: '' });
  const [busy, setBusy] = useState('');
  useEffect(() => {
    api<Session[]>('/api/auth/sessions')
      .then(setSessions)
      .catch(() => setSessions(null));
  }, []);
  async function run(label: string, work: () => Promise<void>) {
    setBusy(label);
    try {
      await work();
    } catch (e) {
      toast((e as Error).message || 'Не получилось');
    } finally {
      setBusy('');
    }
  }
  const saveName = (e: FormEvent) => {
    e.preventDefault();
    void run('name', async () => {
      const updated = await api<User>('/api/me', {
        method: 'PATCH',
        body: JSON.stringify({ name: name.trim() }),
      });
      onUserChange(updated);
      toast('Имя сохранено');
    });
  };
  const savePassword = (e: FormEvent) => {
    e.preventDefault();
    if (passwords.next !== passwords.repeat) return toast('Новые пароли не совпадают');
    void run('password', async () => {
      await api('/api/me/password', {
        method: 'POST',
        body: JSON.stringify({ current: passwords.current, next: passwords.next }),
      });
      setPasswords({ current: '', next: '', repeat: '' });
      setSessions((list) => list?.filter((s) => s.current) ?? list);
      toast('Пароль изменён, другие устройства вышли из аккаунта');
    });
  };
  return (
    <>
      <div className="profile-card">
        <span className="avatar large">{initials(user.name)}</span>
        <span>
          <strong>{user.name}</strong>
          <small>{user.email}</small>
        </span>
        {user.role === 'admin' && <span className="role-badge">Администратор</span>}
      </div>
      <form className="settings-card" onSubmit={saveName}>
        <h2>Имя</h2>
        <label>
          Как к вам обращаться
          <input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="settings-actions">
          <button
            className="primary"
            disabled={!name.trim() || name.trim() === user.name || Boolean(busy)}
          >
            Сохранить
          </button>
        </div>
      </form>
      <form className="settings-card" onSubmit={savePassword}>
        <h2>Пароль</h2>
        <label>
          Текущий пароль
          <input
            type="password"
            autoComplete="current-password"
            value={passwords.current}
            onChange={(e) => setPasswords({ ...passwords, current: e.target.value })}
          />
        </label>
        <div className="settings-fields">
          <label>
            Новый пароль
            <input
              type="password"
              autoComplete="new-password"
              minLength={10}
              value={passwords.next}
              onChange={(e) => setPasswords({ ...passwords, next: e.target.value })}
            />
          </label>
          <label>
            Ещё раз
            <input
              type="password"
              autoComplete="new-password"
              minLength={10}
              value={passwords.repeat}
              onChange={(e) => setPasswords({ ...passwords, repeat: e.target.value })}
            />
          </label>
        </div>
        <p className="small muted">
          Не короче 10 символов. После смены другие устройства выйдут из аккаунта.
        </p>
        <div className="settings-actions">
          <button
            className="primary"
            disabled={
              !passwords.current || passwords.next.length < 10 || !passwords.repeat || Boolean(busy)
            }
          >
            Сменить пароль
          </button>
        </div>
      </form>
      <section className="settings-card">
        <h2>Устройства и входы</h2>
        {!sessions ? (
          <p className="small muted">Список доступен при подключении к серверу.</p>
        ) : (
          sessions.map((session) => (
            <div key={session.id} className="session">
              <span>
                Вход {new Date(session.created_at).toLocaleString('ru')}
                {session.current && <b className="session-current">это устройство</b>}
              </span>
              {!session.current && (
                <button
                  onClick={() =>
                    run('session', async () => {
                      await api(`/api/auth/sessions/${session.id}`, { method: 'DELETE' });
                      setSessions(sessions.filter((s) => s.id !== session.id));
                    })
                  }
                >
                  Завершить
                </button>
              )}
            </div>
          ))
        )}
      </section>
      <section className="settings-card">
        <h2>Выход</h2>
        <p className="small muted">
          Локальные данные остаются в этом браузере для офлайн-доступа. На общем компьютере очистите
          данные сайта после выхода.
        </p>
        <div className="settings-actions start">
          <button
            className="danger-text"
            onClick={async () => {
              try {
                await api('/api/auth/logout', { method: 'POST' });
                onLogout();
              } catch {
                toast('Для завершения сессии нужно подключение к серверу');
              }
            }}
          >
            <LogOut size={17} />
            Выйти из аккаунта
          </button>
        </div>
      </section>
    </>
  );
}

interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: string;
  created_at: string;
  blocked_at: string | null;
}
function UsersSettings({ me, toast }: { me: User; toast: (message: string) => void }) {
  const [state, setState] = useState<{ users: AdminUser[]; registration: string } | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reset, setReset] = useState<{ id: string; password: string } | null>(null);
  /** Удаление: администратор вводит почту пользователя для подтверждения. */
  const [removal, setRemoval] = useState<{ id: string; confirm: string } | null>(null);
  const patchUser = (id: string, patch: Partial<AdminUser>) =>
    setState((current) =>
      current
        ? { ...current, users: current.users.map((x) => (x.id === id ? { ...x, ...patch } : x)) }
        : current,
    );
  const empty = { name: '', email: '', password: '', role: 'user' };
  const [form, setForm] = useState(empty);
  const load = () =>
    api<{ users: AdminUser[]; registration: string }>('/api/admin/users')
      .then((data) => {
        setState(data);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  useEffect(() => {
    void load();
  }, []);
  async function run(work: () => Promise<void>) {
    setBusy(true);
    try {
      await work();
    } catch (e) {
      toast((e as Error).message || 'Не получилось');
    } finally {
      setBusy(false);
    }
  }
  if (failed)
    return (
      <p className="muted settings-lead">
        Управление пользователями доступно при подключении к серверу.{' '}
        <button className="text-button" onClick={() => void load()}>
          Повторить
        </button>
      </p>
    );
  if (!state) return <p className="muted settings-lead">Загрузка…</p>;
  return (
    <>
      <p className="muted settings-lead">Аккаунты на этом сервере. У каждого свои заметки.</p>
      <section className="settings-card">
        <h2>Регистрация</h2>
        <div className="segmented" role="radiogroup" aria-label="Регистрация">
          {(
            [
              ['open', 'Открыта'],
              ['invite', 'По приглашениям'],
              ['closed', 'Закрыта'],
            ] as const
          ).map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={state.registration === mode}
              className={state.registration === mode ? 'selected' : ''}
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const r = await api<{ registration: string }>('/api/admin/registration', {
                    method: 'PUT',
                    body: JSON.stringify({ mode }),
                  });
                  setState({ ...state, registration: r.registration });
                })
              }
            >
              {label}
            </button>
          ))}
        </div>
        <p className="small muted">
          {state.registration === 'open'
            ? 'Любой, кто откроет сервис, может создать себе аккаунт.'
            : state.registration === 'invite'
              ? 'Аккаунт создаётся только по ссылке-приглашению. Ссылки выдаёте вы ниже, а владельцы заметок — когда приглашают в заметку человека без аккаунта.'
              : 'Новых пользователей добавляет только администратор — ниже.'}
        </p>
      </section>
      <InvitesCard registration={state.registration} toast={toast} />
      <section className="settings-card">
        <h2>
          Пользователи <small>{state.users.length}</small>
        </h2>
        <div className="user-list">
          {state.users.map((u) => (
            <div key={u.id} className={`user-row ${u.blocked_at ? 'blocked' : ''}`}>
              <div className="user-main">
                <span className="avatar">{initials(u.name)}</span>
                <span className="user-text">
                  <strong>
                    {u.name}
                    {u.id === me.id && <b className="session-current">вы</b>}
                    {u.blocked_at && <b className="user-blocked">заблокирован</b>}
                  </strong>
                  <small>
                    {u.email} · с {new Date(u.created_at).toLocaleDateString('ru')}
                  </small>
                </span>
                <select
                  aria-label={`Роль ${u.name}`}
                  value={u.role}
                  disabled={busy}
                  onChange={(e) => {
                    const role = e.target.value;
                    void run(async () => {
                      await api(`/api/admin/users/${u.id}`, {
                        method: 'PATCH',
                        body: JSON.stringify({ role }),
                      });
                      if (u.id === me.id && role !== 'admin') location.reload();
                      else
                        setState({
                          ...state,
                          users: state.users.map((x) => (x.id === u.id ? { ...x, role } : x)),
                        });
                    });
                  }}
                >
                  <option value="user">Пользователь</option>
                  <option value="admin">Администратор</option>
                </select>
                {u.id !== me.id && (
                  <>
                    <button
                      className="soft-button"
                      onClick={() => {
                        setRemoval(null);
                        setReset(reset?.id === u.id ? null : { id: u.id, password: '' });
                      }}
                    >
                      Пароль
                    </button>
                    <button
                      className="soft-button"
                      disabled={busy}
                      title={
                        u.blocked_at
                          ? 'Вернуть доступ к аккаунту'
                          : 'Запретить вход; заметки сохранятся, но станут недоступны и другим'
                      }
                      onClick={() => {
                        const blocked = !u.blocked_at;
                        if (
                          blocked &&
                          !window.confirm(
                            `Заблокировать ${u.name}? Все его входы завершатся, а общие заметки, гостевые и публичные ссылки перестанут открываться до разблокировки.`,
                          )
                        )
                          return;
                        void run(async () => {
                          const result = await api<{ blocked_at: string | null }>(
                            `/api/admin/users/${u.id}`,
                            { method: 'PATCH', body: JSON.stringify({ blocked }) },
                          );
                          patchUser(u.id, { blocked_at: result.blocked_at });
                          toast(blocked ? `${u.name} заблокирован` : `${u.name} разблокирован`);
                        });
                      }}
                    >
                      {u.blocked_at ? 'Разблокировать' : 'Заблокировать'}
                    </button>
                    <button
                      className="soft-button danger-text"
                      onClick={() => {
                        setReset(null);
                        setRemoval(removal?.id === u.id ? null : { id: u.id, confirm: '' });
                      }}
                    >
                      Удалить
                    </button>
                  </>
                )}
              </div>
              {removal?.id === u.id && (
                <form
                  className="user-reset user-remove"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void run(async () => {
                      const result = await api<{ notes: number }>(`/api/admin/users/${u.id}`, {
                        method: 'DELETE',
                        body: JSON.stringify({ confirm: removal.confirm }),
                      });
                      setRemoval(null);
                      setState((current) =>
                        current
                          ? { ...current, users: current.users.filter((x) => x.id !== u.id) }
                          : current,
                      );
                      toast(`${u.name} удалён вместе с заметками: ${result.notes}`);
                    });
                  }}
                >
                  <p className="small">
                    Удалятся аккаунт, все заметки, история, картинки, публичные и гостевые ссылки
                    пользователя. Отменить нельзя — сначала сделайте резервную копию. Чтобы
                    подтвердить, введите почту <strong>{u.email}</strong>.
                  </p>
                  <input
                    type="email"
                    autoComplete="off"
                    placeholder={u.email}
                    aria-label={`Почта ${u.name} для подтверждения`}
                    value={removal.confirm}
                    onChange={(e) => setRemoval({ id: u.id, confirm: e.target.value })}
                    autoFocus
                  />
                  <button
                    className="danger"
                    disabled={busy || removal.confirm.trim().toLowerCase() !== u.email}
                  >
                    Удалить навсегда
                  </button>
                </form>
              )}
              {reset?.id === u.id && (
                <form
                  className="user-reset"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void run(async () => {
                      await api(`/api/admin/users/${u.id}`, {
                        method: 'PATCH',
                        body: JSON.stringify({ password: reset.password }),
                      });
                      setReset(null);
                      toast(`Пароль для ${u.name} изменён, его входы завершены`);
                    });
                  }}
                >
                  <input
                    type="password"
                    autoComplete="new-password"
                    placeholder="Новый пароль, от 10 символов"
                    aria-label={`Новый пароль для ${u.name}`}
                    minLength={10}
                    value={reset.password}
                    onChange={(e) => setReset({ id: u.id, password: e.target.value })}
                    autoFocus
                  />
                  <button className="primary" disabled={busy || reset.password.length < 10}>
                    Задать
                  </button>
                </form>
              )}
            </div>
          ))}
        </div>
      </section>
      <form
        className="settings-card"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const created = await api<AdminUser>('/api/admin/users', {
              method: 'POST',
              body: JSON.stringify(form),
            });
            setState({ ...state, users: [...state.users, created] });
            setForm(empty);
            toast(`Пользователь ${created.name} добавлен`);
          });
        }}
      >
        <h2>Добавить пользователя</h2>
        <div className="settings-fields">
          <label>
            Имя
            <input
              value={form.name}
              maxLength={120}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>
          <label>
            Почта
            <input
              type="email"
              autoComplete="off"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </label>
          <label>
            Пароль
            <input
              type="password"
              autoComplete="new-password"
              minLength={10}
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
          </label>
          <label>
            Роль
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              <option value="user">Пользователь</option>
              <option value="admin">Администратор</option>
            </select>
          </label>
        </div>
        <p className="small muted">
          Передайте почту и пароль человеку — он сможет сменить пароль в профиле.
        </p>
        <div className="settings-actions">
          <button
            className="primary"
            disabled={busy || !form.name.trim() || !form.email || form.password.length < 10}
          >
            Добавить
          </button>
        </div>
      </form>
    </>
  );
}

import { useEffect, useState } from 'react';
import { Copy, KeyRound, Link2, RotateCcw, Trash2, Unlock, Users, X } from 'lucide-react';
import { api } from './api';
import { copyInvite, copyText, InviteLinkField, type InviteRow } from './Invites';
import type { Workspace } from './store';

interface Member {
  id: string;
  name: string;
  email: string;
  role: 'editor' | 'reader';
  accepted_at: string | null;
}
export function MembersDialog({
  workspace,
  id,
  close,
}: {
  workspace: Workspace;
  id: string;
  close: () => void;
}) {
  const [members, setMembers] = useState<Member[]>([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'editor' | 'reader'>('editor');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [notice, setNotice] = useState('');
  /** Ссылка на регистрацию, показанная под формой (буфер обмена может быть недоступен). */
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  const toast = (message: string) => setNotice(message);
  const reload = async () => {
    setMembers(await api<Member[]>(`/api/notes/${id}/members`));
    setInvites(await api<InviteRow[]>(`/api/notes/${id}/invites`).catch(() => []));
    await workspace.refreshCollaboration();
  };
  useEffect(() => {
    let active = true;
    api<Member[]>(`/api/notes/${id}/members`)
      .then((rows) => active && setMembers(rows))
      .then(() => api<InviteRow[]>(`/api/notes/${id}/invites`))
      .then((rows) => active && rows && setInvites(rows))
      .catch((e) => active && setError(e.message))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [id]);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    setNotice('');
    setInviteToken(null);
    try {
      await action();
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop" onClick={close}>
      <section
        className="modal share-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="members-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') close();
        }}
      >
        <div className="modal-heading">
          <h2 id="members-title">Совместный доступ</h2>
          <button className="icon-button" aria-label="Закрыть" onClick={close}>
            <X size={20} />
          </button>
        </div>
        <p className="muted small">
          Пригласите пользователя SelfNote по адресу его аккаунта — приглашение появится у него в
          разделе «Общие». Если аккаунта нет, получите ссылку на регистрацию — или создайте гостевую
          ссылку с PIN ниже.
        </p>
        <form
          className="share-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await workspace.whenSynced(id);
              const result = await api<{ invite?: InviteRow }>(`/api/notes/${id}/members`, {
                method: 'POST',
                body: JSON.stringify({ email: email.trim(), role }),
              });
              setEmail('');
              if (result.invite) {
                setInviteToken(result.invite.token);
                const copied = await copyInvite(result.invite.token, toast, { quiet: true });
                setNotice(
                  `У ${result.invite.email} ещё нет аккаунта. ${copied ? 'Ссылка на регистрацию скопирована' : 'Вот ссылка на регистрацию'} — отправьте её; после регистрации доступ к заметке появится сам.`,
                );
              }
            });
          }}
        >
          <label>
            Электронная почта
            <input
              type="email"
              required
              autoFocus
              value={email}
              maxLength={254}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@example.com"
            />
          </label>
          <label>
            Доступ
            <select value={role} onChange={(e) => setRole(e.target.value as Member['role'])}>
              <option value="editor">Редактор — текст и задачи</option>
              <option value="reader">Читатель — только просмотр</option>
            </select>
          </label>
          <button className="primary" disabled={busy || loading || !email.trim()}>
            <Users size={16} />
            Пригласить
          </button>
        </form>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="small muted" role="status">
            {notice}
          </p>
        )}
        {inviteToken && <InviteLinkField token={inviteToken} toast={toast} autoSelect />}
        <h3>Участники</h3>
        <p className="small muted">
          Вы — владелец. Только вы управляете участниками, публичными ссылками и удалением заметки.
        </p>
        {loading ? (
          <p>Загрузка…</p>
        ) : (
          !members.length && !invites.length && <p className="muted">Других участников пока нет.</p>
        )}
        <div className="members-list">
          {invites.map((invite) => (
            <div className="member-row" key={invite.id}>
              <div>
                <strong>{invite.email}</strong>
                <span className="small muted">
                  Ждёт регистрации · {invite.note_role === 'reader' ? 'читатель' : 'редактор'}
                </span>
              </div>
              <button
                className="icon-button"
                aria-label="Скопировать ссылку-приглашение"
                title="Скопировать ссылку"
                onClick={() =>
                  void copyInvite(invite.token, toast, { quiet: true }).then((ok) => {
                    if (ok) return;
                    setInviteToken(invite.token);
                    setNotice(`Ссылка для ${invite.email} — выделите и скопируйте её.`);
                  })
                }
              >
                <Copy size={16} />
              </button>
              <button
                className="icon-button"
                aria-label="Отозвать приглашение"
                title="Отозвать"
                disabled={busy}
                onClick={() =>
                  void run(() => api(`/api/invites/${invite.id}`, { method: 'DELETE' }))
                }
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}
          {members.map((member) => (
            <div className="member-row" key={member.id}>
              <div>
                <strong>{member.name}</strong>
                <span className="small muted">{member.email}</span>
                {!member.accepted_at && (
                  <span className="small muted">Приглашение ожидает ответа</span>
                )}
              </div>
              <select
                aria-label={`Роль: ${member.name}`}
                value={member.role}
                disabled={busy}
                onChange={(e) =>
                  void run(() =>
                    api(`/api/notes/${id}/members/${member.id}`, {
                      method: 'PATCH',
                      body: JSON.stringify({ role: e.target.value }),
                    }),
                  )
                }
              >
                <option value="editor">Редактор</option>
                <option value="reader">Читатель</option>
              </select>
              <button
                className="danger-text"
                disabled={busy}
                onClick={() => {
                  if (window.confirm(`Отозвать доступ у ${member.name}?`))
                    void run(() =>
                      api(`/api/notes/${id}/members/${member.id}`, { method: 'DELETE' }),
                    );
                }}
              >
                Отозвать
              </button>
            </div>
          ))}
        </div>
        <GuestLinks workspace={workspace} id={id} />
      </section>
    </div>
  );
}
export function Invitations({ workspace }: { workspace: Workspace }) {
  const [busy, setBusy] = useState(false);
  const invitations = workspace.collaboration.notes.filter((row) => row.pending);
  if (!invitations.length) return null;
  const respond = async (id: string, accept: boolean) => {
    setBusy(true);
    try {
      await api(
        accept
          ? `/api/notes/${id}/membership/accept`
          : `/api/notes/${id}/members/${workspace.userId}`,
        { method: accept ? 'POST' : 'DELETE' },
      );
      await workspace.refreshCollaboration();
    } catch (e) {
      workspace.toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="invitations" aria-label="Приглашения в заметки">
      <h3>Приглашения</h3>
      {invitations.map((row) => (
        <div className="invitation" key={row.note.id}>
          <strong>{row.note.title || 'Без названия'}</strong>
          <p className="small muted">
            {row.ownerName} · {row.role === 'editor' ? 'Можно редактировать' : 'Только чтение'}
          </p>
          <div>
            <button
              className="primary"
              disabled={busy}
              onClick={() => void respond(row.note.id, true)}
            >
              Принять
            </button>
            <button disabled={busy} onClick={() => void respond(row.note.id, false)}>
              Отклонить
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}
export function NotePresence({
  workspace,
  id,
  name,
}: {
  workspace: Workspace;
  id: string;
  name: string;
}) {
  const [names, setNames] = useState<string[]>([]);
  const entry = workspace.note(id);
  useEffect(() => {
    const awareness = entry.provider.awareness;
    if (!awareness) return;
    awareness.setLocalStateField('user', { id: workspace.userId, name });
    const update = () => {
      const users = new Map<string, string>();
      for (const state of awareness.getStates().values()) {
        const user = state.user;
        if (user && user.id !== workspace.userId && typeof user.name === 'string')
          users.set(String(user.id), user.name.slice(0, 120));
      }
      setNames([...users.values()]);
    };
    awareness.on('change', update);
    update();
    return () => {
      awareness.off('change', update);
      awareness.setLocalStateField('user', null);
    };
  }, [workspace, entry, name]);
  return names.length ? (
    <span className="note-presence">
      <Users size={14} />
      Сейчас в заметке: {names.join(', ')}
    </span>
  ) : null;
}

interface GuestLink {
  id: string;
  token: string;
  role: 'editor' | 'reader';
  label: string | null;
  expires_at: string | null;
  max_devices: number | null;
  locked_until: string | null;
  created_at: string;
  last_used_at: string | null;
  expired: boolean;
  devices: { id: string; name: string; last_seen_at: string }[];
}
export const guestLink = (token: string) => `${location.origin}/g/${token}`;
function randomPin() {
  const values = crypto.getRandomValues(new Uint32Array(6));
  return Array.from(values, (v) => String(v % 10)).join('');
}
const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString('ru', { day: 'numeric', month: 'short' });
/** Гостевые ссылки: доступ без аккаунта по персональной ссылке и PIN. */
function GuestLinks({ workspace, id }: { workspace: Workspace; id: string }) {
  const [links, setLinks] = useState<GuestLink[] | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    label: '',
    pin: randomPin(),
    role: 'editor' as GuestLink['role'],
    expiresInDays: '7',
    maxDevices: '3',
  });
  const [created, setCreated] = useState<{ token: string; pin: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const load = () =>
    api<GuestLink[]>(`/api/notes/${id}/guests`)
      .then(setLinks)
      .catch((e) => {
        setLinks([]);
        setError((e as Error).message);
      });
  useEffect(() => {
    void load();
    // список устройств и блокировок меняется, пока окно открыто
    const timer = setInterval(() => void load(), 15000);
    return () => clearInterval(timer);
  }, [id]);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
      await load();
      await workspace.refreshCollaboration();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const describe = (link: GuestLink) => {
    const parts = [link.role === 'reader' ? 'читатель' : 'редактор'];
    parts.push(
      link.expired
        ? 'срок истёк'
        : link.expires_at
          ? `до ${shortDate(link.expires_at)}`
          : 'бессрочно',
    );
    parts.push(
      `устройств ${link.devices.length}${link.max_devices ? ` из ${link.max_devices}` : ''}`,
    );
    return parts.join(' · ');
  };
  return (
    <>
      <h3>Гостевые ссылки</h3>
      <p className="small muted">
        Для тех, у кого нет аккаунта: персональная ссылка и PIN. Гость вводит имя — оно видно в
        заметке и в истории версий. Пять неверных PIN блокируют ссылку на час. Картинки гости
        добавлять не могут.
      </p>
      {created && (
        <div className="share-created">
          <InviteLinkField
            token={created.token}
            url={guestLink(created.token)}
            label="Гостевая ссылка"
            toast={setNotice}
            autoSelect
          />
          <p className="small">
            PIN: <strong className="guest-pin">{created.pin}</strong> — передайте его отдельно от
            ссылки. Позже PIN посмотреть нельзя, только создать новую ссылку.
          </p>
        </div>
      )}
      {open ? (
        <form
          className="share-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await workspace.whenSynced(id);
              const link = await api<GuestLink>(`/api/notes/${id}/guests`, {
                method: 'POST',
                body: JSON.stringify({
                  role: form.role,
                  pin: form.pin.trim(),
                  label: form.label.trim() || undefined,
                  expiresInDays: form.expiresInDays ? Number(form.expiresInDays) : null,
                  maxDevices: form.maxDevices ? Number(form.maxDevices) : null,
                }),
              });
              setCreated({ token: link.token, pin: form.pin.trim() });
              const copied = await copyText(guestLink(link.token));
              setNotice(copied ? 'Ссылка скопирована. Не забудьте PIN' : '');
              setForm({ ...form, label: '', pin: randomPin() });
              setOpen(false);
            });
          }}
        >
          <label>
            Для кого (видно только вам)
            <input
              value={form.label}
              maxLength={120}
              onChange={(e) => setForm({ ...form, label: e.target.value })}
              placeholder="Например, Дима"
            />
          </label>
          <label>
            PIN — от 6 символов
            <span className="guest-pin-field">
              <input
                required
                minLength={6}
                maxLength={32}
                pattern="\S{6,32}"
                value={form.pin}
                onChange={(e) => setForm({ ...form, pin: e.target.value })}
              />
              <button
                type="button"
                className="icon-button"
                title="Новый PIN"
                aria-label="Сгенерировать PIN"
                onClick={() => setForm({ ...form, pin: randomPin() })}
              >
                <RotateCcw size={16} />
              </button>
            </span>
          </label>
          <label>
            Доступ
            <select
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value as GuestLink['role'] })}
            >
              <option value="editor">Редактор — текст и задачи</option>
              <option value="reader">Читатель — только просмотр</option>
            </select>
          </label>
          <label>
            Срок действия
            <select
              value={form.expiresInDays}
              onChange={(e) => setForm({ ...form, expiresInDays: e.target.value })}
            >
              <option value="1">1 день</option>
              <option value="7">7 дней</option>
              <option value="30">30 дней</option>
              <option value="">Бессрочно</option>
            </select>
          </label>
          <label>
            Устройств на ссылку
            <select
              value={form.maxDevices}
              onChange={(e) => setForm({ ...form, maxDevices: e.target.value })}
            >
              <option value="1">1</option>
              <option value="2">2</option>
              <option value="3">3</option>
              <option value="5">5</option>
              <option value="">Без ограничения</option>
            </select>
          </label>
          <div className="actions">
            <button type="button" onClick={() => setOpen(false)}>
              Отмена
            </button>
            <button className="primary" disabled={busy || form.pin.trim().length < 6}>
              <Link2 size={16} />
              Создать ссылку
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          className="soft-button guest-add"
          onClick={() => {
            setCreated(null);
            setOpen(true);
          }}
        >
          <KeyRound size={16} />
          Новая гостевая ссылка
        </button>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="small muted" role="status">
          {notice}
        </p>
      )}
      {links && links.length > 0 && (
        <div className="members-list guest-links">
          {links.map((link) => (
            <div className="member-row" key={link.id}>
              <div>
                <strong>{link.label || 'Гостевая ссылка'}</strong>
                <span className="small muted">{describe(link)}</span>
                {link.devices.length > 0 && (
                  <span className="small muted">
                    Вошли: {link.devices.map((d) => d.name).join(', ')}
                  </span>
                )}
                {link.locked_until && (
                  <span className="small error">
                    Заблокирована после неверных PIN до{' '}
                    {new Date(link.locked_until).toLocaleTimeString('ru', {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                )}
              </div>
              <select
                aria-label={`Роль: ${link.label || 'гостевая ссылка'}`}
                value={link.role}
                disabled={busy}
                onChange={(e) =>
                  void run(() =>
                    api(`/api/guests/${link.id}`, {
                      method: 'PATCH',
                      body: JSON.stringify({ role: e.target.value }),
                    }),
                  )
                }
              >
                <option value="editor">Редактор</option>
                <option value="reader">Читатель</option>
              </select>
              <button
                className="icon-button"
                aria-label="Скопировать гостевую ссылку"
                title="Скопировать ссылку"
                onClick={() =>
                  void copyText(guestLink(link.token)).then((ok) =>
                    setNotice(
                      ok
                        ? 'Ссылка скопирована'
                        : 'Не удалось скопировать: ' + guestLink(link.token),
                    ),
                  )
                }
              >
                <Copy size={16} />
              </button>
              {link.locked_until && (
                <button
                  className="icon-button"
                  aria-label="Снять блокировку"
                  title="Снять блокировку"
                  disabled={busy}
                  onClick={() =>
                    void run(() =>
                      api(`/api/guests/${link.id}`, {
                        method: 'PATCH',
                        body: JSON.stringify({ unlock: true }),
                      }),
                    )
                  }
                >
                  <Unlock size={16} />
                </button>
              )}
              {link.devices.length > 0 && (
                <button
                  className="danger-text"
                  disabled={busy}
                  title="Отключить все устройства, вошедшие по ссылке"
                  onClick={() => {
                    if (
                      window.confirm('Отключить все устройства? Гостям придётся снова ввести PIN.')
                    )
                      void run(() =>
                        api(`/api/guests/${link.id}`, {
                          method: 'PATCH',
                          body: JSON.stringify({ resetDevices: true }),
                        }),
                      );
                  }}
                >
                  Сбросить устройства
                </button>
              )}
              <button
                className="icon-button"
                aria-label="Отозвать гостевую ссылку"
                title="Отозвать"
                disabled={busy}
                onClick={() => {
                  if (window.confirm('Отозвать ссылку? Гости сразу потеряют доступ.'))
                    void run(() => api(`/api/guests/${link.id}`, { method: 'DELETE' }));
                }}
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

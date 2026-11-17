import { useEffect, useState } from 'react';
import { Users, X } from 'lucide-react';
import { api } from './api';
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
  const reload = async () => {
    setMembers(await api<Member[]>(`/api/notes/${id}/members`));
    await workspace.refreshCollaboration();
  };
  useEffect(() => {
    let active = true;
    api<Member[]>(`/api/notes/${id}/members`)
      .then((rows) => active && setMembers(rows))
      .catch((e) => active && setError(e.message))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [id]);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
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
          Пригласите пользователя SelfNote по адресу его аккаунта. Приглашение появится у него в
          разделе «Общие».
        </p>
        <form
          className="share-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await workspace.whenSynced(id);
              await api(`/api/notes/${id}/members`, {
                method: 'POST',
                body: JSON.stringify({ email: email.trim(), role }),
              });
              setEmail('');
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
        <h3>Участники</h3>
        <p className="small muted">
          Вы — владелец. Только вы управляете участниками, публичными ссылками и удалением заметки.
        </p>
        {loading ? (
          <p>Загрузка…</p>
        ) : (
          !members.length && <p className="muted">Других участников пока нет.</p>
        )}
        <div className="members-list">
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

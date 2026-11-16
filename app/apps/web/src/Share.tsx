import { useEffect, useState } from 'react';
import { Copy, Link2, Lock, Trash2, X } from 'lucide-react';
import { wrapShareKey, type Note } from '@selfnote/shared';
import { api } from './api';
import { Switch } from './Switch';
import { useUI, type Workspace } from './store';

interface ShareRow {
  id: string;
  token: string;
  note_id: string;
  expires_at: string | null;
  encrypted: number;
  views: number;
  created_at: string;
  has_password: boolean;
}
const EXPIRY = [
  { label: 'Бессрочно', days: 0 },
  { label: '1 день', days: 1 },
  { label: '7 дней', days: 7 },
  { label: '30 дней', days: 30 },
];
const linkOf = (row: ShareRow) => `${location.origin}/s/${row.token}`;
const date = (value: string) =>
  new Date(value).toLocaleString('ru', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

/** Публичные ссылки заметки: только чтение, необязательный пароль и срок, отзыв. */
export function ShareDialog({
  workspace,
  note,
  close,
}: {
  workspace: Workspace;
  note: Note;
  close: () => void;
}) {
  const toast = useUI((s) => s.toast);
  const [rows, setRows] = useState<ShareRow[] | null>(null);
  const [error, setError] = useState('');
  const [protect, setProtect] = useState(false);
  const [password, setPassword] = useState('');
  const [days, setDays] = useState(0);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ id: string; url: string } | null>(null);
  const locked = note.encrypted && !workspace.secure.isUnlocked(note.id);
  useEffect(() => {
    api<ShareRow[]>(`/api/notes/${note.id}/shares`)
      .then(setRows)
      .catch(() => setError('Публичные ссылки доступны при подключении к серверу'));
  }, [note.id]);
  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      toast('Ссылка скопирована');
    } catch {
      toast('Не удалось скопировать — выделите ссылку вручную');
    }
  }
  async function create() {
    setBusy(true);
    setError('');
    try {
      // заметка должна дойти до сервера, иначе по ссылке нечего показать
      if (!note.encrypted) await workspace.whenSynced(note.id);
      const row = await api<ShareRow>(`/api/notes/${note.id}/shares`, {
        method: 'POST',
        body: JSON.stringify({
          password: protect ? password : null,
          expiresAt: days ? new Date(Date.now() + days * 86400000).toISOString() : null,
        }),
      });
      let url = linkOf(row);
      if (note.encrypted) {
        const key = workspace.secure.key(note.id);
        if (!key) throw new Error('Откройте заметку, чтобы поделиться ею');
        // ключ — во фрагменте (#…): браузер не отправляет его на сервер
        url += `#${await wrapShareKey(key, protect ? password : undefined)}`;
      }
      setRows((current) => [row, ...(current ?? [])]);
      setCreated({ id: row.id, url });
      setPassword('');
      setProtect(false);
      void copy(url);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function revoke(row: ShareRow) {
    if (!window.confirm('Отозвать ссылку? Она сразу перестанет открываться.')) return;
    try {
      await api(`/api/shares/${row.id}`, { method: 'DELETE' });
      setRows((current) => (current ?? []).filter((r) => r.id !== row.id));
      if (created?.id === row.id) setCreated(null);
    } catch (e) {
      toast((e as Error).message);
    }
  }
  return (
    <div className="modal-backdrop" onClick={close}>
      <section
        className="modal share-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-heading">
          <h2 id="share-title">Поделиться</h2>
          <button className="icon-button" aria-label="Закрыть" onClick={close}>
            <X size={20} />
          </button>
        </div>
        <p className="muted small">
          По ссылке заметку можно только читать, без входа в SelfNote. Изменения видны сразу.
        </p>
        {locked ? (
          <p className="error">
            Сначала откройте заметку паролем — без него ключ для ссылки не получить.
          </p>
        ) : (
          <form
            className="share-form"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <label>
              Срок действия
              <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
                {EXPIRY.map((option) => (
                  <option key={option.days} value={option.days}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <Switch label="Пароль для ссылки" checked={protect} onChange={setProtect} />
            {protect && (
              <label>
                Пароль ссылки (не пароль заметки)
                <input
                  type="password"
                  autoComplete="new-password"
                  minLength={4}
                  maxLength={128}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </label>
            )}
            <button
              className="primary"
              disabled={busy || Boolean(error && !rows) || (protect && password.length < 4)}
            >
              <Link2 size={17} />
              {busy ? 'Создаём…' : 'Создать ссылку'}
            </button>
          </form>
        )}
        {created && (
          <div className="share-created">
            <input
              readOnly
              value={created.url}
              aria-label="Новая ссылка"
              onFocus={(e) => e.target.select()}
            />
            <button
              className="icon-button"
              aria-label="Скопировать ссылку"
              onClick={() => void copy(created.url)}
            >
              <Copy size={17} />
            </button>
            {note.encrypted && (
              <p className="small muted">
                Сохраните ссылку сейчас: ключ расшифровки есть только в ней, сервер его не знает и
                показать ссылку повторно не сможет.
              </p>
            )}
          </div>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {rows && rows.length > 0 && (
          <>
            <h3>Активные ссылки</h3>
            <ul className="share-list">
              {rows.map((row) => (
                <li key={row.id}>
                  <div>
                    <strong>
                      {row.has_password && <Lock size={13} aria-label="С паролем" />}
                      {row.encrypted
                        ? `…/s/${row.token.slice(0, 8)}…`
                        : linkOf(row).replace(/^https?:\/\//, '')}
                    </strong>
                    <small>
                      Создана {date(row.created_at)}
                      {row.expires_at ? ` · до ${date(row.expires_at)}` : ' · бессрочно'} ·
                      просмотров: {row.views}
                    </small>
                  </div>
                  {!row.encrypted && (
                    <button
                      className="icon-button"
                      aria-label="Скопировать ссылку"
                      onClick={() => void copy(linkOf(row))}
                    >
                      <Copy size={16} />
                    </button>
                  )}
                  <button
                    className="icon-button danger-text"
                    aria-label="Отозвать ссылку"
                    onClick={() => void revoke(row)}
                  >
                    <Trash2 size={16} />
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}

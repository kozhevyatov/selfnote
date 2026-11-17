import { useEffect, useState } from 'react';
import { Copy, Link2, Trash2 } from 'lucide-react';
import { api } from './api';

export interface InviteRow {
  id: string;
  token: string;
  email: string | null;
  note_id?: string | null;
  note_role?: string | null;
  expires_at: string;
  created_at?: string;
  created_by_name?: string;
}
export const inviteLink = (token: string) => `${location.origin}/?invite=${token}`;
export async function copyInvite(token: string, toast: (message: string) => void) {
  try {
    await navigator.clipboard.writeText(inviteLink(token));
    toast('Ссылка-приглашение скопирована');
  } catch {
    toast('Не удалось скопировать — выделите ссылку вручную');
  }
}
const until = (iso: string) =>
  new Date(iso).toLocaleDateString('ru', { day: 'numeric', month: 'long' });

/** Настройки → Пользователи: одноразовые ссылки на регистрацию. */
export function InvitesCard({
  registration,
  toast,
}: {
  registration: string;
  toast: (message: string) => void;
}) {
  const [rows, setRows] = useState<InviteRow[] | null>(null);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () =>
    api<InviteRow[]>('/api/admin/invites')
      .then(setRows)
      .catch(() => setRows([]));
  useEffect(() => {
    void load();
  }, []);
  async function run(work: () => Promise<void>) {
    setBusy(true);
    try {
      await work();
      await load();
    } catch (e) {
      toast((e as Error).message || 'Не получилось');
    } finally {
      setBusy(false);
    }
  }
  const closed = registration === 'closed';
  return (
    <section className="settings-card">
      <h2>Приглашения {rows && rows.length > 0 && <small>{rows.length}</small>}</h2>
      <p className="small muted">
        {closed
          ? 'Регистрация закрыта — ссылки-приглашения не действуют. Включите режим «По приглашениям».'
          : 'Одноразовая ссылка на регистрацию, действует 7 дней. Можно привязать к адресу почты.'}
      </p>
      {!closed && (
        <form
          className="invite-create"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const created = await api<InviteRow>('/api/admin/invites', {
                method: 'POST',
                body: JSON.stringify({ email: email.trim() }),
              });
              setEmail('');
              await copyInvite(created.token, toast);
            });
          }}
        >
          <input
            type="email"
            value={email}
            maxLength={254}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Почта (необязательно)"
            aria-label="Почта приглашённого"
          />
          <button className="primary" disabled={busy}>
            <Link2 size={16} /> Создать ссылку
          </button>
        </form>
      )}
      {rows && rows.length > 0 && (
        <ul className="share-list">
          {rows.map((row) => (
            <li key={row.id}>
              <div>
                <strong>{row.email || 'Любой адрес'}</strong>
                <small>
                  {row.note_id ? 'В заметку · ' : ''}
                  {row.created_by_name ? `от ${row.created_by_name} · ` : ''}
                  до {until(row.expires_at)}
                </small>
              </div>
              {!closed && (
                <button
                  className="icon-button"
                  aria-label="Скопировать ссылку"
                  title="Скопировать ссылку"
                  onClick={() => void copyInvite(row.token, toast)}
                >
                  <Copy size={16} />
                </button>
              )}
              <button
                className="icon-button"
                aria-label="Отозвать приглашение"
                title="Отозвать"
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    api(`/api/invites/${row.id}`, { method: 'DELETE' }).then(() => undefined),
                  )
                }
              >
                <Trash2 size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

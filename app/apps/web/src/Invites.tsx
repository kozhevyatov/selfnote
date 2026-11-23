import { useEffect, useState } from 'react';
import { Copy, Link2, Trash2 } from 'lucide-react';
import { api } from './api';
import { publicOrigin } from './platform';

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
export const inviteLink = (token: string) => `${publicOrigin()}/?invite=${token}`;

/**
 * Копирование в буфер обмена с запасным путём: navigator.clipboard есть только
 * в защищённом контексте (HTTPS/localhost), а Safari/WebView отказывают в записи,
 * если с момента нажатия прошёл await. Тогда пробуем старый execCommand('copy').
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* падаем на запасной путь */
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  area.style.pointerEvents = 'none';
  document.body.appendChild(area);
  const active = document.activeElement as HTMLElement | null;
  area.select();
  area.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  active?.focus?.();
  return ok;
}

export async function copyInvite(
  token: string,
  toast: (message: string) => void,
  { quiet = false }: { quiet?: boolean } = {},
) {
  if (await copyText(inviteLink(token))) toast('Ссылка-приглашение скопирована');
  else if (!quiet) toast('Не удалось скопировать — выделите ссылку вручную');
  else return false;
  return true;
}

/** Ссылка на экране: поле только для чтения (выделяется по клику) + кнопка копирования. */
export function InviteLinkField({
  token,
  toast,
  autoSelect = false,
  url = inviteLink(token),
  label = 'Ссылка-приглашение',
}: {
  token: string;
  toast: (message: string) => void;
  autoSelect?: boolean;
  /** Другая ссылка (гостевая) вместо приглашения на регистрацию. */
  url?: string;
  label?: string;
}) {
  return (
    <div className="share-created invite-link">
      <input
        readOnly
        value={url}
        aria-label={label}
        autoFocus={autoSelect}
        onFocus={(e) => e.target.select()}
        onClick={(e) => e.currentTarget.select()}
      />
      <button
        type="button"
        className="icon-button"
        aria-label="Скопировать ссылку"
        title="Скопировать ссылку"
        onClick={() =>
          void copyText(url).then((ok) =>
            toast(ok ? 'Ссылка скопирована' : 'Не удалось скопировать — выделите ссылку вручную'),
          )
        }
      >
        <Copy size={16} />
      </button>
    </div>
  );
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
  /** Приглашение, чья ссылка сейчас показана (только что созданное или раскрытое в списке). */
  const [shown, setShown] = useState<string | null>(null);
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
              setShown(created.id);
              // после await браузер может запретить запись в буфер — тогда молча,
              // ссылка всё равно на экране
              await copyInvite(created.token, toast, { quiet: true });
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
            <li key={row.id} className={shown === row.id ? 'invite-open' : undefined}>
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
                  aria-label={shown === row.id ? 'Скрыть ссылку' : 'Показать ссылку'}
                  aria-expanded={shown === row.id}
                  title={shown === row.id ? 'Скрыть ссылку' : 'Показать ссылку'}
                  onClick={() => setShown(shown === row.id ? null : row.id)}
                >
                  <Link2 size={16} />
                </button>
              )}
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
              {!closed && shown === row.id && (
                <InviteLinkField token={row.token} toast={toast} autoSelect />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

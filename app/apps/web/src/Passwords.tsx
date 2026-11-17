import { savePasswordVersion, type Credential, type PasswordSnapshot } from './vault';
import { useEffect, useState, useRef } from 'react';
import * as Y from 'yjs';
import { ChevronDown, Copy, Eye, EyeOff, KeyRound, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { uuid } from './ids';
import { type Workspace } from './store';

function VaultGate({
  workspace,
  ready,
  cancel,
}: {
  workspace: Workspace;
  ready: () => Promise<void>;
  cancel?: () => void;
}) {
  const [setup, setSetup] = useState<boolean | null>(null);
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    workspace.vault
      .configuration()
      .then((payload) => {
        if (active) setSetup(!payload);
      })
      .catch((e: Error) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [workspace]);
  return (
    <form
      className="vault-gate"
      onSubmit={async (e) => {
        e.preventDefault();
        if (setup === null || (setup && password !== repeat)) return;
        setBusy(true);
        setError('');
        try {
          await workspace.vault.unlock(password, setup);
          setPassword('');
          setRepeat('');
          await ready();
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <KeyRound size={30} />
      <h2>{setup ? 'Настройте мастер-пароль' : 'Разблокировать пароли'}</h2>
      <p>Один мастер-пароль для всех заметок «Пароли». Он отличается от пароля входа.</p>
      {setup && (
        <p>
          Забудете мастер-пароль — восстановить доступ нельзя, даже через администратора. Сохраните
          его в надёжном месте.
        </p>
      )}
      <label>
        Мастер-пароль
        <input
          type="password"
          autoComplete={setup ? 'new-password' : 'current-password'}
          required
          minLength={setup ? 12 : 1}
          maxLength={256}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      {setup && (
        <label>
          Повторите мастер-пароль
          <input
            type="password"
            autoComplete="new-password"
            required
            value={repeat}
            onChange={(e) => setRepeat(e.target.value)}
          />
        </label>
      )}
      {setup && repeat && repeat !== password && <p role="alert">Пароли не совпадают</p>}
      <p className="small muted">
        Автоблокировка через 5 минут бездействия и при переходе в другую вкладку. Названия и поля
        зашифрованы; книжки и метки видны серверу.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        {cancel && (
          <button type="button" onClick={cancel} disabled={busy}>
            Отмена
          </button>
        )}
        <button
          className="primary"
          disabled={busy || setup === null || Boolean(setup && password !== repeat)}
        >
          {busy ? 'Подождите…' : setup ? 'Создать хранилище' : 'Разблокировать'}
        </button>
      </div>
    </form>
  );
}

export function NewNoteButton({
  workspace,
  passwordsOnly = false,
}: {
  workspace: Workspace;
  passwordsOnly?: boolean;
}) {
  const [gate, setGate] = useState(false);
  const [busy, setBusy] = useState(false);
  const menu = useRef<HTMLDetailsElement>(null);
  // Меню типа заметки закрывается кликом в любом месте вне его и по Escape.
  useEffect(() => {
    const outside = (e: PointerEvent) => {
      const details = menu.current;
      if (details?.open && !details.contains(e.target as Node)) details.open = false;
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && menu.current?.open) menu.current.open = false;
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, []);
  async function create() {
    setBusy(true);
    try {
      await workspace.vault.create();
      setGate(false);
    } catch (e) {
      workspace.toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {passwordsOnly ? (
        <button
          disabled={busy}
          onClick={() => (workspace.vault.unlocked ? void create() : setGate(true))}
        >
          <Plus size={18} />
          Пароли
        </button>
      ) : (
        <div className="new-note-split">
          <button className="primary" onClick={() => workspace.createNote()}>
            <Plus size={18} />
            Новая заметка
          </button>
          <details className="create-menu" ref={menu}>
            <summary aria-label="Выбрать тип заметки">
              <ChevronDown size={18} />
            </summary>
            <div
              className="create-options"
              onClick={(e) => {
                e.currentTarget.closest('details')?.removeAttribute('open');
              }}
            >
              <button onClick={() => workspace.createNote()}>Заметка</button>
              <button onClick={() => workspace.createNote(true)}>Список задач</button>
              <button
                disabled={busy}
                onClick={() => (workspace.vault.unlocked ? void create() : setGate(true))}
              >
                <KeyRound size={16} />
                Пароли
              </button>
            </div>
          </details>
        </div>
      )}
      {gate && (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true" aria-label="Мастер-пароль">
            <VaultGate workspace={workspace} ready={create} cancel={() => setGate(false)} />
          </div>
        </div>
      )}
    </>
  );
}

export function PasswordEditor({ workspace, id }: { workspace: Workspace; id: string }) {
  const doc = workspace.secure.doc(id);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!doc && workspace.vault.unlocked)
      void workspace.vault.open(id).catch((e: Error) => setError(e.message));
  }, [workspace, id, doc]);
  if (!doc)
    return (
      <div className="password-editor">
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <VaultGate workspace={workspace} ready={() => workspace.vault.open(id)} />
      </div>
    );
  return <PasswordFields key={doc.guid} workspace={workspace} id={id} doc={doc} />;
}

function PasswordFields({ workspace, id, doc }: { workspace: Workspace; id: string; doc: Y.Doc }) {
  const [shown, setShown] = useState<string | null>(null);
  const [history, setHistory] = useState(false);
  const entries = doc.getArray<Credential>('credentials');
  const versions = doc.getArray<PasswordSnapshot>('passwordVersions');
  const secure = doc.getMap<string>('secure');
  const readOnly = Boolean(workspace.metadata.get(id)?.deletedAt);
  function snapshot() {
    savePasswordVersion(doc);
  }
  useEffect(() => {
    if (readOnly) return;
    snapshot();
    const timer = setInterval(snapshot, 5 * 60_000);
    return () => {
      clearInterval(timer);
      if (!doc.isDestroyed) snapshot();
    };
    // Снимок читает актуальные Yjs-поля, а не состояние React.
  }, [doc, readOnly]);
  function change(index: number, field: keyof Omit<Credential, 'id'>, value: string) {
    const entry = entries.get(index);
    doc.transact(() => {
      entries.delete(index, 1);
      entries.insert(index, [{ ...entry, [field]: value }]);
    });
    workspace.update(id, {});
  }
  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      workspace.toast('Скопировано');
      setTimeout(() => {
        if (!document.hasFocus()) return;
        void navigator.clipboard
          .readText()
          .then((current) => {
            if (current === value) return navigator.clipboard.writeText('');
          })
          .catch(() => {
            /* Браузер может запретить чтение или очистку. */
          });
      }, 30_000);
    } catch {
      workspace.toast('Браузер не разрешил доступ к буферу обмена');
    }
  }
  function generate() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%&*+-=?';
    let result = '';
    while (result.length < 24) {
      const value = crypto.getRandomValues(new Uint8Array(1))[0];
      if (value < 256 - (256 % alphabet.length)) result += alphabet[value % alphabet.length];
    }
    return result;
  }
  return (
    <section className="password-editor" aria-label="Пароли">
      <div className="password-heading">
        <span>
          <KeyRound size={18} /> Пароли
        </span>
        <button onClick={() => workspace.vault.lock()}>Заблокировать всё</button>
      </div>
      <label>
        Название
        <input
          value={secure.get('title') || ''}
          placeholder="Например, домашний сервер"
          disabled={readOnly}
          onChange={(e) => {
            secure.set('title', e.target.value);
            workspace.update(id, {});
          }}
        />
      </label>
      {entries.toArray().map((entry, index) => (
        <fieldset className="credential" key={entry.id} disabled={readOnly}>
          <legend>Запись {index + 1}</legend>
          <label>
            Название записи
            <input
              autoComplete="off"
              value={entry.name}
              onChange={(e) => change(index, 'name', e.target.value)}
            />
          </label>
          <label>
            Ссылка или адрес
            <input
              autoComplete="off"
              value={entry.url}
              onChange={(e) => change(index, 'url', e.target.value)}
            />
          </label>
          <label>
            Логин
            <div className="credential-field">
              <input
                autoComplete="off"
                value={entry.login}
                onChange={(e) => change(index, 'login', e.target.value)}
              />
              <button
                type="button"
                aria-label="Копировать логин"
                onClick={() => void copy(entry.login)}
              >
                <Copy size={18} />
              </button>
            </div>
          </label>
          <label>
            Пароль
            <div className="credential-field">
              <input
                autoComplete="new-password"
                spellCheck={false}
                onFocus={snapshot}
                type={shown === entry.id ? 'text' : 'password'}
                value={entry.password}
                onChange={(e) => change(index, 'password', e.target.value)}
              />
              <button
                type="button"
                aria-label={shown === entry.id ? 'Скрыть пароль' : 'Показать пароль'}
                onClick={() => setShown(shown === entry.id ? null : entry.id)}
              >
                {shown === entry.id ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
              <button
                type="button"
                aria-label="Копировать пароль"
                onClick={() => void copy(entry.password)}
              >
                <Copy size={18} />
              </button>
              <button
                type="button"
                aria-label="Сгенерировать пароль"
                onClick={() => {
                  if (
                    entry.password &&
                    !confirm('Заменить пароль новым? Старый сохранится в истории.')
                  )
                    return;
                  snapshot();
                  change(index, 'password', generate());
                }}
              >
                <RefreshCw size={18} />
              </button>
            </div>
          </label>
          <div className="credential-actions">
            <button
              type="button"
              disabled={index === 0}
              onClick={() =>
                doc.transact(() => {
                  entries.delete(index, 1);
                  entries.insert(index - 1, [entry]);
                })
              }
            >
              Выше
            </button>
            <button
              type="button"
              disabled={index === entries.length - 1}
              onClick={() =>
                doc.transact(() => {
                  entries.delete(index, 1);
                  entries.insert(index + 1, [entry]);
                })
              }
            >
              Ниже
            </button>
            <button
              type="button"
              onClick={() => entries.insert(index + 1, [{ ...entry, id: uuid() }])}
            >
              Дублировать
            </button>
            <button
              type="button"
              aria-label="Удалить запись"
              onClick={() => {
                if (confirm('Удалить запись? Она останется в зашифрованной истории.')) {
                  snapshot();
                  entries.delete(index, 1);
                }
              }}
            >
              <Trash2 size={18} />
            </button>
          </div>
        </fieldset>
      ))}
      <button
        disabled={readOnly}
        onClick={() => entries.push([{ id: uuid(), name: '', url: '', login: '', password: '' }])}
      >
        <Plus size={18} />
        Добавить запись
      </button>
      <div className="actions">
        <button onClick={() => setHistory(!history)}>История</button>
        <button
          disabled={readOnly}
          onClick={() => {
            snapshot();
            workspace.toast('Версия сохранена');
          }}
        >
          Сохранить версию
        </button>
      </div>
      {history && (
        <div className="password-history">
          <p>Последние 50 версий. Содержимое хранится зашифрованным.</p>
          {versions
            .toArray()
            .slice()
            .reverse()
            .map((version) => (
              <div key={version.id}>
                <span>
                  {new Date(version.date).toLocaleString('ru')} · {version.entries.length} записей
                </span>
                <button
                  disabled={readOnly}
                  onClick={() => {
                    if (
                      !confirm('Восстановить эту версию? Текущее содержимое останется в истории.')
                    )
                      return;
                    snapshot();
                    doc.transact(() => {
                      secure.set('title', version.title);
                      entries.delete(0, entries.length);
                      entries.push(version.entries);
                    });
                    setShown(null);
                  }}
                >
                  Восстановить
                </button>
              </div>
            ))}
        </div>
      )}
      <p className="small muted">
        Автосохранение. Через 30 секунд попробуем очистить скопированное значение. Браузер может
        запретить очистку буфера.
      </p>
    </section>
  );
}

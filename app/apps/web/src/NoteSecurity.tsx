import { useState } from 'react';
import type { Note } from '@selfnote/shared';
import { Switch } from './Switch';
import { useUI, type Workspace } from './store';

export type PasswordMode = 'set' | 'change' | 'remove';
const TITLES: Record<PasswordMode, string> = {
  set: 'Пароль на заметку',
  change: 'Сменить пароль',
  remove: 'Снять пароль?',
};
/** Поставить, сменить или снять пароль заметки. */
export function PasswordDialog({
  workspace,
  note,
  mode,
  close,
}: {
  workspace: Workspace;
  note: Note;
  mode: PasswordMode;
  close: () => void;
}) {
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [hideTitle, setHideTitle] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useUI((s) => s.toast);
  const needsPassword = mode !== 'remove';
  const mismatch = needsPassword && repeat !== '' && password !== repeat;
  return (
    <div className="modal-backdrop" onClick={busy ? undefined : close}>
      <form
        className="modal password-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="password-title"
        onClick={(e) => e.stopPropagation()}
        onSubmit={async (e) => {
          e.preventDefault();
          if (needsPassword && password !== repeat) return setError('Пароли не совпадают');
          setBusy(true);
          setError('');
          try {
            if (mode === 'set') {
              await workspace.secure.enable(note.id, password, hideTitle);
              toast('Заметка зашифрована');
            } else if (mode === 'change') {
              await workspace.secure.changePassword(note.id, password);
              toast('Пароль изменён');
            } else {
              await workspace.secure.disable(note.id);
              toast('Пароль снят');
            }
            close();
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <h2 id="password-title">{TITLES[mode]}</h2>
        {mode === 'remove' ? (
          <p>
            Заметка снова будет храниться на сервере в открытом виде и синхронизироваться как
            обычная. Публичные ссылки на неё перестанут работать.
          </p>
        ) : (
          <>
            <label>
              Новый пароль
              <input
                type="password"
                autoFocus
                autoComplete="new-password"
                minLength={4}
                maxLength={256}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </label>
            <label>
              Повторите пароль
              <input
                type="password"
                autoComplete="new-password"
                value={repeat}
                onChange={(e) => setRepeat(e.target.value)}
                aria-invalid={mismatch}
                required
              />
            </label>
            {mismatch && <p className="small danger-text">Пароли не совпадают</p>}
            {mode === 'set' && (
              <>
                <Switch
                  label="Скрыть и заголовок — в списке будет «Заметка под паролем»"
                  checked={hideTitle}
                  onChange={setHideTitle}
                />
                <ul className="password-notes small muted">
                  <li>
                    <strong>Забудете пароль — заметку не восстановить.</strong> Его не знает никто,
                    включая администратора.
                  </li>
                  <li>Шифрование на этом устройстве: сервер хранит только шифр.</li>
                  <li>История версий заметки будет удалена с сервера.</li>
                  <li>Картинки в заметке не шифруются. Совместное редактирование недоступно.</li>
                </ul>
              </>
            )}
            {mode === 'change' && (
              <p className="small muted">
                На других устройствах заметку нужно будет открыть уже с новым паролем.
              </p>
            )}
          </>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="actions">
          <button type="button" onClick={close} disabled={busy}>
            Отмена
          </button>
          <button
            className={mode === 'remove' ? 'danger' : 'primary'}
            disabled={busy || (needsPassword && (password.length < 4 || password !== repeat))}
          >
            {busy
              ? mode === 'set'
                ? 'Шифруем…'
                : 'Сохраняем…'
              : mode === 'set'
                ? 'Зашифровать'
                : mode === 'change'
                  ? 'Сменить пароль'
                  : 'Снять пароль'}
          </button>
        </div>
      </form>
    </div>
  );
}

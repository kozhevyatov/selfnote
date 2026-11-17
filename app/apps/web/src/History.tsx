import { Switch } from './Switch';
import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import * as Y from 'yjs';
import { extractDocument } from '@selfnote/shared';
import { api } from './api';
import { Workspace } from './store';
import { VersionPreview } from './Editor';
import { textDiff } from './historyDiff';
interface Version {
  id: string;
  created_at: string;
  author_name: string | null;
  author: string;
  label: string | null;
}
export function History({
  workspace,
  id,
  close,
}: {
  workspace: Workspace;
  id: string;
  close: () => void;
}) {
  const [versions, setVersions] = useState<Version[]>([]);
  const [selected, setSelected] = useState('');
  const [snapshot, setSnapshot] = useState<Y.Doc | null>(null);
  const [diff, setDiff] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    api<Version[]>(`/api/notes/${id}/versions`)
      .then((rows) => {
        if (active) {
          setVersions(rows);
          setError('');
        }
      })
      .catch((e) => active && setError(e.message))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [id, reload]);
  useEffect(() => {
    let active = true;
    let doc: Y.Doc | null = null;
    setSnapshot(null);
    if (selected)
      api<{ state: string }>(`/api/notes/${id}/versions/${selected}`)
        .then((row) => {
          if (!active) return;
          doc = new Y.Doc();
          Y.applyUpdate(
            doc,
            Uint8Array.from(atob(row.state), (c) => c.charCodeAt(0)),
          );
          setSnapshot(doc);
          setError('');
        })
        .catch((e) => active && setError(e.message));
    return () => {
      active = false;
      doc?.destroy();
    };
  }, [id, selected]);
  async function restore() {
    if (!window.confirm('Восстановить эту версию? Текущее содержимое останется в истории.')) return;
    const entry = workspace.note(id);
    if (!entry.provider.isSynced || entry.provider.hasUnsyncedChanges) {
      setError('Дождитесь синхронизации заметки перед восстановлением.');
      return;
    }
    setBusy(true);
    try {
      await api(`/api/notes/${id}/versions/${selected}/restore`, { method: 'POST', body: '{}' });
      workspace.update(id, {});
      setReload((n) => n + 1);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const changes =
    snapshot && diff
      ? textDiff(extractDocument(snapshot).plainText, workspace.extract(id).plainText)
      : [];
  let day = '';
  return (
    <aside className="history-panel" aria-label="История версий">
      <header>
        <h2>История</h2>
        <button className="icon-button" onClick={close} aria-label="Закрыть историю">
          <X size={19} />
        </button>
      </header>
      <button
        disabled={busy || !workspace.canEdit(id)}
        onClick={async () => {
          await workspace.saveVersion(id);
          setReload((n) => n + 1);
        }}
      >
        Сохранить версию
      </button>
      {error && (
        <p role="alert">
          {error} <button onClick={() => setReload((n) => n + 1)}>Повторить</button>
        </p>
      )}
      {loading ? <p>Загрузка…</p> : !versions.length && <p>Сохранённых версий пока нет.</p>}
      <div className="history-versions">
        {versions.map((v) => {
          const date = new Date(v.created_at).toLocaleDateString('ru');
          const heading = date !== day;
          day = date;
          return (
            <div key={v.id}>
              {heading && <h3>{date}</h3>}
              <button
                disabled={busy}
                className={selected === v.id ? 'active' : ''}
                onClick={() => setSelected(v.id)}
              >
                <time>
                  {new Date(v.created_at).toLocaleTimeString('ru', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </time>
                <span className="version-author">{v.author_name || 'Пользователь'}</span>
                {v.label && <small>{v.label}</small>}
              </button>
            </div>
          );
        })}
      </div>
      {snapshot && (
        <section className="history-preview">
          <Switch label="Показать изменения" checked={diff} onChange={setDiff} />
          {diff ? (
            <>
              <p>Изменения от выбранной версии к текущей (текст).</p>
              <div className="history-diff">
                {changes.map((part, i) =>
                  part.kind === 'added' ? (
                    <ins key={i}>{part.text}</ins>
                  ) : part.kind === 'removed' ? (
                    <del key={i}>{part.text}</del>
                  ) : (
                    <span key={i}>{part.text}</span>
                  ),
                )}
              </div>
            </>
          ) : (
            <VersionPreview doc={snapshot} userId={workspace.userId} />
          )}
          <button
            className="primary"
            disabled={busy || !workspace.canEdit(id)}
            onClick={() => void restore()}
          >
            {busy ? 'Восстанавливаем…' : 'Восстановить'}
          </button>
        </section>
      )}
    </aside>
  );
}

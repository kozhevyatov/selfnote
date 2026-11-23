import { useEffect, useRef, useState } from 'react';
import { Download, Upload, DatabaseBackup, RotateCcw, Trash2, FileArchive } from 'lucide-react';
import { api, token } from './api';
import type { Workspace } from './store';
import { exportMarkdown, exportSelfnote, download } from './transfer/exporters';
import {
  readImportFile,
  applyImport,
  type ImportPlan,
  type ImportReport,
} from './transfer/importers';
import { apiUrl } from './platform';

const KIND: Record<ImportPlan['kind'], string> = {
  nsx: 'Synology Note Station',
  markdown: 'Markdown',
  selfnote: 'Копия SelfNote',
};
const size = (bytes: number) =>
  bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} МБ` : `${Math.ceil(bytes / 1024)} КБ`;
const when = (iso?: string) => (iso ? new Date(iso).toLocaleString('ru') : '—');
const plural = (n: number, one: string, few: string, many: string) =>
  `${n} ${n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many}`;

/** Экспорт и импорт заметок. */
export function DataSettings({
  workspace,
  toast,
}: {
  workspace: Workspace;
  toast: (message: string) => void;
}) {
  const [scope, setScope] = useState('all');
  const [busy, setBusy] = useState('');
  const [progress, setProgress] = useState<[number, number] | null>(null);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const notebooks = [...workspace.notebooks.values()];

  async function run(label: string, work: () => Promise<void>) {
    setBusy(label);
    try {
      await work();
    } catch (e) {
      toast((e as Error).message || 'Не получилось');
    } finally {
      setBusy('');
      setProgress(null);
    }
  }
  const onProgress = (done: number, total: number) => setProgress([done, total]);

  return (
    <div className="data-settings">
      <h3>Экспорт</h3>
      <p className="small muted">
        Файл сохраняется на этот компьютер. Работает и без сети, заметки из корзины не входят.
      </p>
      <label>
        Что выгрузить
        <select value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="all">Все заметки</option>
          {notebooks.map((b) => (
            <option key={b.id} value={b.id}>
              Книжка «{b.name}»
            </option>
          ))}
        </select>
      </label>
      <div className="data-actions">
        <button
          disabled={Boolean(busy)}
          onClick={() =>
            run('Готовим Markdown…', async () => {
              const result = await exportMarkdown(
                workspace,
                scope === 'all' ? undefined : scope,
                onProgress,
              );
              download(result.blob, result.name);
              toast(
                `Выгружено: ${plural(result.notes, 'заметка', 'заметки', 'заметок')}, ${plural(result.images, 'картинка', 'картинки', 'картинок')}` +
                  (result.warnings.length ? `. Пропущено картинок: ${result.warnings.length}` : ''),
              );
            })
          }
        >
          <Download size={17} /> Markdown + картинки
        </button>
        <button
          disabled={Boolean(busy) || scope !== 'all'}
          title={scope !== 'all' ? 'Полная копия — всегда все заметки' : undefined}
          onClick={() =>
            run('Готовим копию…', async () => {
              const result = await exportSelfnote(workspace, onProgress);
              download(result.blob, result.name);
              toast(`Копия готова: ${plural(result.notes, 'заметка', 'заметки', 'заметок')}`);
            })
          }
        >
          <FileArchive size={17} /> Полная копия SelfNote
        </button>
      </div>

      <h3>Импорт</h3>
      <p className="small muted">
        Synology Note Station (.nsx), Markdown (.md или .zip с папками — например, из Obsidian),
        копия SelfNote (.zip). Повторный импорт того же файла не создаёт дублей.
      </p>
      <button
        className="data-file"
        disabled={Boolean(busy)}
        onClick={() => fileInput.current?.click()}
      >
        <Upload size={17} /> Выбрать файл…
      </button>
      <input
        ref={fileInput}
        type="file"
        hidden
        accept=".nsx,.zip,.md,.markdown,.txt"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          setReport(null);
          void run('Читаем файл…', async () => setPlan(await readImportFile(file)));
        }}
      />
      {plan && !report && (
        <div className="data-card">
          <strong>
            {KIND[plan.kind]} · {plan.fileName}
          </strong>
          <p className="small">
            {plural(plan.notes.length, 'заметка', 'заметки', 'заметок')}
            {plan.books.length ? `, книжки: ${plan.books.slice(0, 6).join(', ')}` : ''}
            {plan.books.length > 6 ? ` и ещё ${plan.books.length - 6}` : ''}
          </p>
          {plan.skipped.length > 0 && (
            <p className="small muted">
              Не будут перенесены: {plan.skipped.length} (подробности — после импорта)
            </p>
          )}
          <div className="data-actions">
            <button
              className="primary"
              disabled={Boolean(busy) || !plan.notes.length}
              onClick={() =>
                run('Импортируем…', async () => {
                  setReport(await applyImport(workspace, plan, onProgress));
                  setPlan(null);
                })
              }
            >
              Импортировать
            </button>
            <button disabled={Boolean(busy)} onClick={() => setPlan(null)}>
              Отмена
            </button>
          </div>
        </div>
      )}
      {report && (
        <div className="data-card" role="status">
          <strong>Импорт завершён</strong>
          <p className="small">
            Добавлено {plural(report.notes, 'заметка', 'заметки', 'заметок')},{' '}
            {plural(report.tasks, 'задача', 'задачи', 'задач')},{' '}
            {plural(report.images, 'картинка', 'картинки', 'картинок')}
            {report.books ? `, новых книжек: ${report.books}` : ''}
            {report.sections ? `, подразделов: ${report.sections}` : ''}.
            {report.duplicates ? ` Уже были импортированы раньше: ${report.duplicates}.` : ''}
          </p>
          {report.skipped.length > 0 && (
            <details>
              <summary>Не перенесено: {report.skipped.length}</summary>
              <ul className="small">
                {report.skipped.map((s, i) => (
                  <li key={i}>
                    «{s.title}» — {s.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {report.warnings.length > 0 && (
            <details>
              <summary>Замечания: {report.warnings.length}</summary>
              <ul className="small">
                {report.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </details>
          )}
          <button className="text-button" onClick={() => setReport(null)}>
            Закрыть отчёт
          </button>
        </div>
      )}
      {busy && (
        <div className="data-progress" role="status">
          <span className="small">{busy}</span>
          {progress && <progress value={progress[0]} max={progress[1]} />}
        </div>
      )}
    </div>
  );
}

interface BackupInfo {
  name: string;
  size: number;
  created_at: string;
  kind: 'auto' | 'manual' | 'before-restore' | 'other';
}
interface BackupState {
  backups: BackupInfo[];
  status: {
    lastSuccess?: string;
    lastFile?: string;
    lastError?: string | null;
    lastAttempt?: string;
  };
  schedule: { enabled: boolean; hour: number; timezone: string };
  directory: string;
}
const KIND_LABEL: Record<BackupInfo['kind'], string> = {
  auto: 'автоматическая',
  manual: 'вручную',
  'before-restore': 'перед восстановлением',
  other: '',
};

export function Backups({ toast }: { toast: (message: string) => void }) {
  const [state, setState] = useState<BackupState | null>(null);
  const [busy, setBusy] = useState('');
  const restoreInput = useRef<HTMLInputElement>(null);
  const load = () =>
    api<BackupState>('/api/admin/backups')
      .then(setState)
      .catch((e) => toast((e as Error).message));
  useEffect(() => {
    void load();
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
  const restored = (result: { safety?: string }) => {
    alert(
      'Данные восстановлены.' +
        (result.safety ? ` Состояние до восстановления сохранено копией ${result.safety}.` : '') +
        ' Страница перезагрузится; при необходимости войдите заново.',
    );
    location.reload();
  };
  const warning =
    'Все данные сервера будут заменены содержимым копии (перед этим текущее состояние сохранится отдельной копией).\n\n' +
    'Устройства, которые работали офлайн, после подключения вернут свои локальные правки.\n\nПродолжить?';
  return (
    <>
      {!state ? (
        <p className="small muted">Загрузка…</p>
      ) : (
        <>
          <p className="small">
            {state.status.lastError ? (
              <span className="error-text">
                Последняя попытка {when(state.status.lastAttempt)} не удалась:{' '}
                {state.status.lastError}
              </span>
            ) : (
              <>Последняя копия: {when(state.status.lastSuccess)}</>
            )}
          </p>
          <p className="small muted">
            {state.schedule.enabled
              ? `Автоматически раз в сутки после ${state.schedule.hour}:00 (${state.schedule.timezone}). Хранятся 7 ежедневных, 4 еженедельных и 6 ежемесячных копий; ручные удаляйте сами.`
              : 'Автоматические копии выключены (BACKUP_ENABLED=false).'}{' '}
            Папка на сервере: <code>{state.directory}</code>
          </p>
          <div className="data-actions">
            <button
              disabled={Boolean(busy)}
              onClick={() =>
                run('Создаём копию…', async () => {
                  const b = await api<BackupInfo>('/api/admin/backups', {
                    method: 'POST',
                    body: '{}',
                  });
                  toast(`Копия создана: ${b.name}`);
                  await load();
                })
              }
            >
              <DatabaseBackup size={17} /> Создать копию сейчас
            </button>
            <button disabled={Boolean(busy)} onClick={() => restoreInput.current?.click()}>
              <RotateCcw size={17} /> Восстановить из файла…
            </button>
            <input
              ref={restoreInput}
              type="file"
              hidden
              accept=".zip"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (!file || !confirm(warning)) return;
                void run('Восстанавливаем…', async () => {
                  const form = new FormData();
                  form.append('file', file);
                  restored(await api('/api/admin/restore', { method: 'POST', body: form }));
                });
              }}
            />
          </div>
          {busy && <p className="small muted">{busy}</p>}
          <div className="backup-list">
            {state.backups.length === 0 && <p className="small muted">Копий пока нет</p>}
            {state.backups.map((b) => (
              <div key={b.name} className="backup-row">
                <span className="small">
                  {when(b.created_at)}
                  <span className="muted">
                    {' '}
                    · {size(b.size)}
                    {KIND_LABEL[b.kind] ? ` · ${KIND_LABEL[b.kind]}` : ''}
                  </span>
                </span>
                <span className="backup-actions">
                  <button
                    className="icon-button"
                    aria-label={`Скачать копию ${b.name}`}
                    disabled={Boolean(busy)}
                    onClick={() =>
                      run('Скачиваем…', async () => {
                        const response = await fetch(apiUrl(`/api/admin/backups/${b.name}`), {
                          headers: { Authorization: `Bearer ${await token()}` },
                        });
                        if (!response.ok) throw new Error('Не удалось скачать копию');
                        const blob = await response.blob();
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = b.name;
                        a.click();
                        setTimeout(() => URL.revokeObjectURL(url), 10000);
                      })
                    }
                  >
                    <Download size={16} />
                  </button>
                  <button
                    className="icon-button"
                    aria-label={`Восстановить из копии от ${when(b.created_at)}`}
                    disabled={Boolean(busy)}
                    onClick={() => {
                      if (!confirm(warning)) return;
                      void run('Восстанавливаем…', async () =>
                        restored(
                          await api('/api/admin/restore', {
                            method: 'POST',
                            body: JSON.stringify({ name: b.name }),
                          }),
                        ),
                      );
                    }}
                  >
                    <RotateCcw size={16} />
                  </button>
                  <button
                    className="icon-button danger-text"
                    aria-label={`Удалить копию от ${when(b.created_at)}`}
                    disabled={Boolean(busy)}
                    onClick={() => {
                      if (!confirm('Удалить эту резервную копию навсегда?')) return;
                      void run('Удаляем…', async () => {
                        await api(`/api/admin/backups/${b.name}`, { method: 'DELETE' });
                        await load();
                      });
                    }}
                  >
                    <Trash2 size={16} />
                  </button>
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}

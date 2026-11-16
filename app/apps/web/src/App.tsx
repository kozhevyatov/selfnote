import { ColorPicker } from './ColorPicker';
import { Switch } from './Switch';
import { History } from './History';
import { uuid } from './ids';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  FileText,
  Plus,
  Search,
  CheckSquare,
  Users,
  Trash2,
  Settings2,
  ChevronRight,
  ChevronDown,
  Book,
  Menu,
  X,
  Pin,
  ArchiveRestore,
  LogOut,
  Clock3,
  MoreHorizontal,
  Tag,
  ArrowLeft,
  Check,
  Sun,
  NotebookPen,
} from 'lucide-react';
import MiniSearch from 'minisearch';
import {
  localDate,
  dueDay,
  setTaskChecked,
  type Note,
  type Notebook,
  type Section,
} from '@selfnote/shared';
import { api, refresh, setToken, type User } from './api';
import { Auth } from './Auth';
import { DataSettings } from './DataSettings';
import { Workspace, useUI } from './store';
import { NoteEditor, Due } from './Editor';
import { flushImages } from './attachments';
const colors = ['#C2410C', '#3451D1', '#2B7A3D', '#7A3DB8'];
interface Dialog {
  title: string;
  value: string;
  label: string;
  danger?: boolean;
  confirm?: string;
  action: (value: string, color: string) => void;
  color?: string;
}
export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [setup, setSetup] = useState(false);
  const [registration, setRegistration] = useState('closed');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    void (async () => {
      try {
        const config = await api<{ required: boolean; registration: string }>('/api/setup');
        setSetup(config.required);
        setRegistration(config.registration);
        if (!config.required) {
          try {
            const result = await refresh();
            setUser(result.user);
            localStorage.setItem('selfnote-user', JSON.stringify(result.user));
          } catch {
            localStorage.removeItem('selfnote-user');
          }
        }
      } catch {
        const cached = localStorage.getItem('selfnote-user');
        if (cached) setUser(JSON.parse(cached));
        else setError('Не удалось связаться с сервером. Проверьте соединение и попробуйте снова.');
      } finally {
        setLoading(false);
      }
    })();
  }, []);
  if (loading)
    return (
      <div className="loading">
        <span className="brand-icon">
          <FileText />
        </span>
        <p>Открываем SelfNote…</p>
      </div>
    );
  if (error)
    return (
      <div className="loading">
        <p>{error}</p>
        <button onClick={() => location.reload()}>Попробовать снова</button>
      </div>
    );
  if (!user)
    return (
      <Auth
        setup={setup}
        registration={registration}
        onLogin={(value) => {
          localStorage.setItem('selfnote-user', JSON.stringify(value));
          setUser(value);
          setSetup(false);
        }}
      />
    );
  return (
    <Shell
      key={user.id}
      user={user}
      onLogout={() => {
        setUser(null);
        localStorage.removeItem('selfnote-user');
        setToken('');
      }}
    />
  );
}
function Shell({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  useEffect(() => {
    const next = new Workspace(user.id);
    setWorkspace(next);
    return () => next.destroy();
  }, [user.id]);
  return workspace ? (
    <WorkspaceShell user={user} onLogout={onLogout} workspace={workspace} />
  ) : (
    <div className="loading">Открываем локальную базу…</div>
  );
}
function WorkspaceShell({
  user,
  onLogout,
  workspace,
}: {
  user: User;
  onLogout: () => void;
  workspace: Workspace;
}) {
  const revision = useSyncExternalStore(workspace.subscribe, workspace.snapshot);
  const ui = useUI();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => new Set(JSON.parse(localStorage.getItem(`collapsed:${user.id}`) || '[]')),
  );
  const [settings, setSettings] = useState(false);
  const [more, setMore] = useState(false);
  const [sessions, setSessions] = useState<
    { id: string; created_at: string; expires_at: string }[]
  >([]);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const online = () => workspace.emit();
    window.addEventListener('online', online);
    window.addEventListener('offline', online);
    const timer = setInterval(() => {
      void flushImages(workspace);
    }, 10000);
    return () => {
      clearInterval(timer);
      window.removeEventListener('online', online);
      window.removeEventListener('offline', online);
    };
  }, [workspace]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey) {
        if (e.key.toLowerCase() === 'n') {
          e.preventDefault();
          workspace.createNote();
        }
        if (e.key.toLowerCase() === 'k') {
          e.preventDefault();
          searchRef.current?.focus();
        }
        if (e.shiftKey && e.key.toLowerCase() === 'l') {
          e.preventDefault();
          workspace.createNote(true);
        }
      }
      if (e.key === 'Escape') {
        setDialog(null);
        setSettings(false);
        setMore(false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [workspace]);
  useEffect(() => {
    if (ui.message) {
      const timer = setTimeout(() => useUI.setState({ message: '' }), 5000);
      return () => clearTimeout(timer);
    }
  }, [ui.message]);
  const notebooks = [...workspace.notebooks.values()];
  const sections = [...workspace.sections.values()];
  const notes = [...workspace.metadata.values()];
  const [history, setHistory] = useState(false);
  const [accent, setAccent] = useState(() => localStorage.getItem('accent') || '#3451D1');
  const selected = ui.selected ? workspace.metadata.get(ui.selected) : undefined;
  const tasks = workspace.getTasks();
  const todayTasks = tasks.filter((t) => !t.checked && t.due && dueDay(t.due) <= localDate());
  // Индекс строится только во время поиска; текст заметок берётся из кэша Workspace.
  const searching = Boolean(ui.query);
  const index = useMemo(() => {
    if (!searching) return null;
    const search = new MiniSearch({
      fields: ['title', 'text', 'tags'],
      searchOptions: { prefix: true, fuzzy: 0.2 },
    });
    search.addAll(
      [...workspace.metadata.values()].map((n) => ({
        id: n.id,
        title: n.title,
        text: workspace.extract(n.id).plainText,
        tags: n.tags.join(' '),
      })),
    );
    return search;
  }, [workspace, revision, searching]);
  const matches = index && ui.query ? new Set(index.search(ui.query).map((r) => r.id)) : null;
  const filtered = notes
    .filter((n) => (ui.filter === 'trash' ? Boolean(n.deletedAt) : !n.deletedAt))
    .filter((n) => !matches || matches.has(n.id))
    .filter(
      (n) =>
        ['all', 'trash', 'tasks'].includes(ui.filter) ||
        ui.filter === n.notebookId ||
        ui.filter === n.sectionId ||
        (ui.filter.startsWith('tag:') && n.tags.includes(ui.filter.slice(4))),
    );
  const currentNotebook = workspace.notebooks.get(ui.filter);
  const currentSection = workspace.sections.get(ui.filter);
  const title =
    ui.filter === 'all'
      ? 'Все заметки'
      : ui.filter === 'tasks'
        ? 'Задачи'
        : ui.filter === 'shared'
          ? 'Общие'
          : ui.filter === 'trash'
            ? 'Корзина'
            : ui.filter.startsWith('tag:')
              ? '#' + ui.filter.slice(4)
              : currentNotebook?.name || currentSection?.name || 'Все заметки';
  // Группы как в макете: Закреплённые, Сегодня, Вчера, На этой неделе, затем месяцы.
  const groups = new Map<string, Note[]>();
  const captions = new Map<string, string>();
  const now = new Date();
  const today = localDate(now);
  const yesterdayDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const weekStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - ((now.getDay() + 6) % 7),
  );
  const dayMonth = (d: Date) => d.toLocaleDateString('ru', { day: 'numeric', month: 'long' });
  for (const note of filtered.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
    const updated = new Date(note.updatedAt);
    const date = localDate(updated);
    let group: string;
    let caption = '';
    if (note.pinned && !note.deletedAt) group = 'Закреплённые';
    else if (date === today) {
      group = 'Сегодня';
      caption = dayMonth(now);
    } else if (date === localDate(yesterdayDate)) {
      group = 'Вчера';
      caption = dayMonth(yesterdayDate);
    } else if (updated >= weekStart) {
      group = 'На этой неделе';
      const end = new Date(
        yesterdayDate.getFullYear(),
        yesterdayDate.getMonth(),
        yesterdayDate.getDate() - 1,
      );
      caption =
        weekStart.getMonth() === end.getMonth()
          ? `${weekStart.getDate()}–${dayMonth(end)}`
          : `${dayMonth(weekStart)} – ${dayMonth(end)}`;
    } else {
      const month = updated.toLocaleDateString('ru', { month: 'long' });
      group = month[0].toUpperCase() + month.slice(1);
      if (updated.getFullYear() !== now.getFullYear()) group += ` ${updated.getFullYear()}`;
      caption = String(updated.getFullYear());
    }
    if (!groups.has(group)) groups.set(group, []);
    if (caption) captions.set(group, caption);
    groups.get(group)!.push(note);
  }
  const groupList = [...groups].sort(([a], [b]) =>
    a === 'Закреплённые' ? -1 : b === 'Закреплённые' ? 1 : 0,
  );
  function editNotebook(book?: Notebook) {
    setDialog({
      title: book ? 'Переименовать книжку' : 'Новая записная книжка',
      label: 'Название',
      value: book?.name || '',
      color: book?.color || colors[notebooks.length % colors.length],
      action: (name, color) => {
        const id = book?.id || uuid();
        workspace.notebooks.set(id, { id, name, color });
        if (!book) ui.setFilter(id);
      },
    });
  }
  function editSection(notebookId: string, section?: Section) {
    setDialog({
      title: section ? 'Переименовать подраздел' : 'Новый подраздел',
      label: 'Название',
      value: section?.name || '',
      action: (name) => {
        const id = section?.id || uuid();
        workspace.sections.set(id, { id, notebookId, name });
        ui.setFilter(id);
      },
    });
  }
  function removeNotebook(book: Notebook) {
    setDialog({
      title: `Удалить «${book.name}»?`,
      label: 'Заметки останутся в разделе «Все заметки».',
      value: '',
      danger: true,
      confirm: 'Удалить книжку',
      action: () => {
        workspace.space.doc.transact(() => {
          for (const note of notes)
            if (note.notebookId === book.id)
              workspace.update(note.id, { notebookId: null, sectionId: null });
          for (const section of sections)
            if (section.notebookId === book.id) workspace.sections.delete(section.id);
          workspace.notebooks.delete(book.id);
        });
        ui.setFilter('all');
      },
    });
  }
  function removeSection(section: Section) {
    setDialog({
      title: `Удалить «${section.name}»?`,
      label: 'Заметки останутся в записной книжке.',
      value: '',
      danger: true,
      action: () => {
        workspace.space.doc.transact(() => {
          for (const note of notes)
            if (note.sectionId === section.id) workspace.update(note.id, { sectionId: null });
          workspace.sections.delete(section.id);
        });
        ui.setFilter(section.notebookId);
      },
    });
  }
  function addTag() {
    setDialog({
      title: 'Новая метка',
      label: 'Название без #',
      value: '',
      action: (value) => {
        const name = value.replace(/^#+/, '');
        if (name) workspace.tags.set(name, name);
      },
    });
  }
  function toggleCollapse(id: string) {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setCollapsed(next);
    localStorage.setItem(`collapsed:${user.id}`, JSON.stringify([...next]));
  }
  async function openSettings() {
    setSettings(true);
    try {
      setSessions(await api('/api/auth/sessions'));
    } catch {
      ui.toast('Список сессий доступен при подключении к серверу');
    }
  }
  const nav = (filter: string, label: string, Icon: typeof FileText, badge?: string | number) => (
    <button
      className={`nav-item ${ui.filter === filter ? 'selected' : ''}`}
      onClick={() => {
        ui.setFilter(filter);
        if (filter === 'tasks') useUI.setState({ mobile: 'editor' });
      }}
    >
      <Icon size={18} />
      <span>{label}</span>
      {badge !== undefined && <small className={filter === 'tasks' ? 'blue' : ''}>{badge}</small>}
    </button>
  );
  return (
    <div className={`app mobile-${ui.mobile}`}>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-icon">
            <FileText size={19} />
          </span>
          <strong>SelfNote</strong>
          <button
            className="icon-button mobile-only"
            aria-label="Закрыть меню"
            onClick={() => useUI.setState({ mobile: 'list' })}
          >
            <X size={18} />
          </button>
        </div>
        <button className="primary new-note" onClick={() => workspace.createNote()}>
          <Plus size={18} />
          Новая заметка
        </button>
        <div className="nav-scroll">
          <nav>
            {nav('all', 'Все заметки', FileText, notes.filter((n) => !n.deletedAt).length)}
            {nav(
              'tasks',
              'Задачи',
              CheckSquare,
              todayTasks.length ? `${todayTasks.length} сегодня` : undefined,
            )}
            {nav('shared', 'Общие', Users)}
          </nav>
          <div className="section-heading">
            <span>Записные книжки</span>
            <button
              className="icon-button"
              aria-label="Новая записная книжка"
              onClick={() => editNotebook()}
            >
              <Plus size={16} />
            </button>
          </div>
          {notebooks.map((book) => (
            <div key={book.id} className="notebook">
              <div className={`book-row ${ui.filter === book.id ? 'selected' : ''}`}>
                <button
                  className="collapse-button"
                  aria-label={collapsed.has(book.id) ? 'Развернуть книжку' : 'Свернуть книжку'}
                  onClick={() => toggleCollapse(book.id)}
                >
                  {collapsed.has(book.id) ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                </button>
                <button className="book-name" onClick={() => ui.setFilter(book.id)}>
                  <span
                    className="book-icon"
                    style={{ color: book.color, background: `${book.color}12` }}
                  >
                    <Book size={14} />
                  </span>
                  <span>{book.name}</span>
                  <small>
                    {notes.filter((n) => !n.deletedAt && n.notebookId === book.id).length}
                  </small>
                </button>
                <details className="row-menu">
                  <summary aria-label={`Действия с книжкой ${book.name}`}>
                    <MoreHorizontal size={15} />
                  </summary>
                  <div className="popover">
                    <button onClick={() => editNotebook(book)}>Переименовать</button>
                    <button onClick={() => editSection(book.id)}>Добавить подраздел</button>
                    <button className="danger-text" onClick={() => removeNotebook(book)}>
                      Удалить
                    </button>
                  </div>
                </details>
              </div>
              {!collapsed.has(book.id) && (
                <div className="subsections">
                  {sections
                    .filter((s) => s.notebookId === book.id)
                    .map((section) => (
                      <div key={section.id} className="subsection-row">
                        <button
                          className={ui.filter === section.id ? 'selected' : ''}
                          onClick={() => ui.setFilter(section.id)}
                        >
                          {section.name}
                        </button>
                        <details className="row-menu">
                          <summary aria-label={`Действия с подразделом ${section.name}`}>
                            <MoreHorizontal size={14} />
                          </summary>
                          <div className="popover">
                            <button onClick={() => editSection(book.id, section)}>
                              Переименовать
                            </button>
                            <button className="danger-text" onClick={() => removeSection(section)}>
                              Удалить
                            </button>
                          </div>
                        </details>
                      </div>
                    ))}
                  <button className="add-section" onClick={() => editSection(book.id)}>
                    <Plus size={14} /> Подраздел
                  </button>
                </div>
              )}
            </div>
          ))}
          {!notebooks.length && (
            <button className="empty-nav" onClick={() => editNotebook()}>
              Создайте книжку для работы, дома или новых идей
            </button>
          )}
          <div className="section-heading">
            <span>Метки</span>
            <button className="icon-button" aria-label="Добавить метку" onClick={addTag}>
              <Plus size={16} />
            </button>
          </div>
          <div className="tags">
            {[...workspace.tags.keys()].map((tag) => (
              <button
                key={tag}
                className={ui.filter === `tag:${tag}` ? 'active' : ''}
                onClick={() => ui.setFilter(`tag:${tag}`)}
              >
                #{tag}
              </button>
            ))}
            {!workspace.tags.size && <button onClick={addTag}>+ Добавить метку</button>}
          </div>
        </div>
        <div className="sidebar-bottom">
          {nav('trash', 'Корзина', Trash2)}
          <button className="nav-item" onClick={() => void openSettings()}>
            <Settings2 size={18} />
            Настройки
          </button>
          <button className="profile" onClick={() => void openSettings()}>
            <span className="avatar">
              {user.name
                .split(' ')
                .slice(0, 2)
                .map((n) => n[0])
                .join('')
                .toUpperCase()}
            </span>
            <span>
              <strong>{user.name}</strong>
              <small>
                <i className={workspace.status === 'Синхронизировано' ? 'online' : 'offline'} />
                {workspace.status}
              </small>
            </span>
            <ChevronDown size={15} />
          </button>
        </div>
      </aside>
      <section className="note-list panel">
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
              {currentSection && (
                <small>{workspace.notebooks.get(currentSection.notebookId)?.name}</small>
              )}
              <h1>{title}</h1>
            </div>
            <button
              className="icon-button soft"
              aria-label="Новая заметка"
              onClick={() => workspace.createNote()}
            >
              <NotebookPen size={19} />
            </button>
          </div>
          <label className="search">
            <Search size={17} />
            <input
              ref={searchRef}
              placeholder="Поиск"
              aria-label="Поиск заметок"
              value={ui.query}
              onChange={(e) => useUI.setState({ query: e.target.value })}
            />
            {ui.query ? (
              <button
                className="icon-button"
                aria-label="Очистить поиск"
                onClick={() => useUI.setState({ query: '' })}
              >
                <X size={15} />
              </button>
            ) : (
              <kbd>⌘K</kbd>
            )}
          </label>
        </header>
        {ui.filter === 'trash' && (
          <button
            className="danger-text"
            disabled={!notes.some((n) => n.deletedAt)}
            onClick={() => {
              if (window.confirm('Очистить корзину? Все заметки в ней будут удалены навсегда.'))
                workspace.deleteForever(notes.filter((n) => n.deletedAt).map((n) => n.id));
            }}
          >
            Очистить корзину
          </button>
        )}
        <div className="notes-scroll">
          {ui.filter === 'shared' ? (
            <div className="empty">
              <Users size={30} />
              <h3>Общее пространство</h3>
              <p>Публичные ссылки и совместный доступ появятся на следующих этапах.</p>
            </div>
          ) : (
            groupList.map(([group, items]) => (
              <section key={group} className="date-group">
                <h2>
                  {group}
                  {captions.has(group) && <small>{captions.get(group)}</small>}
                </h2>
                {items.map((note) => (
                  <button
                    key={note.id}
                    className={`note-row ${ui.selected === note.id ? 'selected' : ''}`}
                    onClick={() => ui.select(note.id)}
                  >
                    <span className="note-row-top">
                      <strong>{note.title || 'Без названия'}</strong>
                      <time>
                        {new Date(note.updatedAt).toLocaleTimeString('ru', {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </time>
                    </span>
                    <span className="note-preview">
                      {workspace.extract(note.id).plainText.replace(/\n/g, ' ') ||
                        'Пока здесь чистый лист'}
                    </span>
                  </button>
                ))}
              </section>
            ))
          )}
          {!filtered.length && ui.filter !== 'shared' && (
            <div className="empty">
              <FileText size={30} />
              <h3>
                {ui.query
                  ? 'Ничего не найдено'
                  : ui.filter === 'trash'
                    ? 'Корзина пуста'
                    : 'Здесь будут ваши заметки'}
              </h3>
              <p>
                {ui.query ? 'Попробуйте другие слова.' : 'Начните с мысли, плана или списка дел.'}
              </p>
              {ui.filter !== 'trash' && (
                <button onClick={() => workspace.createNote()}>
                  <Plus size={16} />
                  Новая заметка
                </button>
              )}
            </div>
          )}
        </div>
        <footer className="list-footer">
          {filtered.length}{' '}
          {new Intl.PluralRules('ru').select(filtered.length) === 'one'
            ? 'заметка'
            : new Intl.PluralRules('ru').select(filtered.length) === 'few'
              ? 'заметки'
              : 'заметок'}
          <span>Сохраняются автоматически</span>
        </footer>
      </section>
      <main className="editor-panel panel">
        {selected ? (
          <>
            <header className="editor-header">
              <div className="breadcrumb">
                <Book size={14} />
                <span>
                  {selected.notebookId
                    ? workspace.notebooks.get(selected.notebookId)?.name
                    : 'Все заметки'}
                </span>
                {selected.sectionId && (
                  <>
                    <span>/</span>
                    <span>{workspace.sections.get(selected.sectionId)?.name}</span>
                  </>
                )}
              </div>
              <span className="modified">
                Изменено в{' '}
                {new Date(selected.updatedAt).toLocaleTimeString('ru', {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
              <div className="editor-actions">
                <button aria-label="История" title="История" onClick={() => setHistory((v) => !v)}>
                  История
                </button>
                <button
                  className="icon-button"
                  title="Сохранить версию"
                  aria-label="Сохранить версию"
                  onClick={() => {
                    void workspace.saveVersion(selected.id);
                    ui.toast(
                      navigator.onLine
                        ? 'Версия поставлена в очередь сохранения'
                        : 'Версия сохранится на сервере после подключения',
                    );
                  }}
                >
                  <Clock3 size={18} />
                </button>
                <button
                  className={`icon-button ${selected.pinned ? 'active' : ''}`}
                  aria-label={selected.pinned ? 'Открепить заметку' : 'Закрепить заметку'}
                  onClick={() => workspace.update(selected.id, { pinned: !selected.pinned })}
                >
                  <Pin size={17} />
                </button>
                <div className="menu-wrap">
                  <button
                    className="icon-button"
                    aria-label="Действия с заметкой"
                    onClick={() => setMore(!more)}
                  >
                    <MoreHorizontal size={19} />
                  </button>
                  {more && (
                    <div className="popover note-menu">
                      <label>
                        Записная книжка
                        <select
                          value={selected.notebookId || ''}
                          onChange={(e) =>
                            workspace.update(selected.id, {
                              notebookId: e.target.value || null,
                              sectionId: null,
                            })
                          }
                        >
                          <option value="">Без книжки</option>
                          {notebooks.map((n) => (
                            <option key={n.id} value={n.id}>
                              {n.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      {selected.notebookId && (
                        <label>
                          Подраздел
                          <select
                            value={selected.sectionId || ''}
                            onChange={(e) =>
                              workspace.update(selected.id, { sectionId: e.target.value || null })
                            }
                          >
                            <option value="">Без подраздела</option>
                            {sections
                              .filter((s) => s.notebookId === selected.notebookId)
                              .map((s) => (
                                <option key={s.id} value={s.id}>
                                  {s.name}
                                </option>
                              ))}
                          </select>
                        </label>
                      )}
                      <div className="menu-tags">
                        {[...workspace.tags.keys()].map((tag) => (
                          <Switch
                            key={tag}
                            label={`#${tag}`}
                            checked={selected.tags.includes(tag)}
                            onChange={(checked) =>
                              workspace.update(selected.id, {
                                tags: checked
                                  ? [...selected.tags, tag]
                                  : selected.tags.filter((t) => t !== tag),
                              })
                            }
                          />
                        ))}
                      </div>
                      <button
                        onClick={() => {
                          addTag();
                          setMore(false);
                        }}
                      >
                        <Tag size={16} />
                        Новая метка
                      </button>
                      {selected.deletedAt ? (
                        <button
                          onClick={() => {
                            workspace.update(selected.id, { deletedAt: null });
                            setMore(false);
                            ui.setFilter('all');
                          }}
                        >
                          <ArchiveRestore size={16} />
                          Восстановить
                        </button>
                      ) : (
                        <button
                          className="danger-text"
                          onClick={() => {
                            workspace.update(selected.id, { deletedAt: new Date().toISOString() });
                            ui.select(null);
                            setMore(false);
                          }}
                        >
                          <Trash2 size={16} />В корзину
                        </button>
                      )}
                    </div>
                  )}
                </div>
                <button
                  className="icon-button"
                  aria-label="Закрыть заметку"
                  onClick={() => ui.select(null)}
                >
                  <X size={19} />
                </button>
              </div>
            </header>
            {selected.tags.length > 0 && (
              <div className="note-tags">
                {selected.tags.map((tag) => (
                  <button key={tag} onClick={() => ui.setFilter(`tag:${tag}`)}>
                    #{tag}
                  </button>
                ))}
              </div>
            )}
            {selected.deletedAt ? (
              <div className="deleted-banner">
                Заметка в корзине
                <button
                  className="danger-text"
                  onClick={() => {
                    if (
                      window.confirm('Удалить заметку навсегда? Восстановить её будет невозможно.')
                    )
                      workspace.deleteForever([selected.id]);
                  }}
                >
                  Удалить навсегда
                </button>
                <button onClick={() => workspace.update(selected.id, { deletedAt: null })}>
                  Восстановить
                </button>
              </div>
            ) : null}
            {history && (
              <History
                key={selected.id}
                workspace={workspace}
                id={selected.id}
                close={() => setHistory(false)}
              />
            )}
            <div className="editor-scroll">
              <NoteEditor key={selected.id} workspace={workspace} id={selected.id} />
            </div>
            <footer className="editor-footer">
              <Check size={14} />
              Сохранено на устройстве<span>{workspace.status}</span>
            </footer>
          </>
        ) : ui.filter === 'tasks' ? (
          <div className="tasks-page">
            <button
              className="mobile-only text-button"
              onClick={() => useUI.setState({ mobile: 'list' })}
            >
              <ArrowLeft size={18} />К списку
            </button>
            <h1>Все задачи</h1>
            <p className="muted">Небольшие шаги к большим планам</p>
            {(['Сегодня', 'Просрочено', 'Предстоящие', 'Без срока', 'Выполненные'] as const).map(
              (group) => {
                const items = tasks.filter((t) =>
                  group === 'Выполненные'
                    ? t.checked
                    : t.checked
                      ? false
                      : group === 'Без срока'
                        ? !t.due
                        : !!t.due &&
                          (group === 'Сегодня'
                            ? dueDay(t.due) === localDate()
                            : group === 'Просрочено'
                              ? dueDay(t.due) < localDate()
                              : dueDay(t.due) > localDate()),
                );
                return (
                  <div className="task-group" key={group}>
                    <h2>
                      {group}
                      <small>{items.length}</small>
                    </h2>
                    <TaskRows tasks={items} workspace={workspace} />
                    {!items.length && <p className="small muted">Пока нет задач</p>}
                  </div>
                );
              },
            )}
          </div>
        ) : (
          <div className="welcome-scroll">
            <div className="welcome">
              <span className="welcome-icon">
                <FileText size={28} />
              </span>
              <h1>
                {new Date().getHours() < 6
                  ? 'Доброй ночи'
                  : new Date().getHours() < 12
                    ? 'Доброе утро'
                    : new Date().getHours() < 18
                      ? 'Добрый день'
                      : 'Добрый вечер'}
                , {user.name.split(' ')[0]}
              </h1>
              <p className="welcome-description">
                Выберите заметку слева или начните новую. Всё сохраняется само, даже без интернета.
              </p>
              <div className="welcome-actions">
                <button className="primary" onClick={() => workspace.createNote()}>
                  <Plus size={18} />
                  Новая заметка
                </button>
                <button className="soft" onClick={() => workspace.createNote(true)}>
                  <ListIcon />
                  Новый список задач
                </button>
              </div>
              <section className="today-card">
                <div className="today-heading">
                  <h2>На сегодня</h2>
                  <span>
                    {todayTasks.length ? `осталось ${todayTasks.length}` : 'всё спокойно'}
                  </span>
                  <button
                    onClick={() => {
                      ui.setFilter('tasks');
                      useUI.setState({ mobile: 'editor' });
                    }}
                  >
                    Все задачи
                  </button>
                </div>
                {todayTasks.length ? (
                  <TaskRows tasks={todayTasks} workspace={workspace} />
                ) : (
                  <div className="today-empty">
                    <Sun size={28} />
                    <strong>Можно выдохнуть</strong>
                    <p>
                      Задачи на сегодня и просроченные
                      <br />
                      появятся здесь.
                    </p>
                  </div>
                )}
              </section>
              <div className="shortcuts">
                <span>
                  <b>⌘N</b> новая заметка
                </span>
                <span>
                  <b>⌘K</b> поиск
                </span>
                <span>
                  <b>⌘⇧L</b> список задач
                </span>
              </div>
            </div>
          </div>
        )}
      </main>
      {ui.message && (
        <div className="toast" role="status">
          {ui.message}
          <button aria-label="Закрыть уведомление" onClick={() => useUI.setState({ message: '' })}>
            <X size={16} />
          </button>
        </div>
      )}
      {dialog && <EditDialog dialog={dialog} close={() => setDialog(null)} />}{' '}
      {settings && (
        <div className="modal-backdrop" onClick={() => setSettings(false)}>
          <section
            className="modal settings-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-heading">
              <h2 id="settings-title">Настройки</h2>
              <button
                className="icon-button"
                aria-label="Закрыть настройки"
                onClick={() => setSettings(false)}
              >
                <X size={20} />
              </button>
            </div>
            <h3>{user.name}</h3>
            <p className="muted">{user.email}</p>
            <div className="settings-color">
              <span>Цвет акцента</span>
              <ColorPicker
                value={accent}
                label="Цвет акцента"
                onChange={(color) => {
                  setAccent(color);
                  document.documentElement.style.setProperty('--accent', color);
                  localStorage.setItem('accent', color);
                }}
              />
            </div>
            <DataSettings workspace={workspace} user={user} toast={ui.toast} />
            <h3>Сессии</h3>
            {sessions.map((session) => (
              <div key={session.id} className="session">
                <span>Вход {new Date(session.created_at).toLocaleString('ru')}</span>
                <button
                  onClick={async () => {
                    try {
                      await api(`/api/auth/sessions/${session.id}`, { method: 'DELETE' });
                      setSessions(sessions.filter((s) => s.id !== session.id));
                    } catch (e) {
                      ui.toast((e as Error).message);
                    }
                  }}
                >
                  Завершить
                </button>
              </div>
            ))}
            <p className="small muted">
              При выходе локальные данные остаются в этом браузере для офлайн-доступа. На общем
              компьютере очистите данные сайта после выхода.
            </p>
            <button
              className="danger-text"
              onClick={async () => {
                try {
                  await api('/api/auth/logout', { method: 'POST' });
                  onLogout();
                } catch {
                  ui.toast('Для завершения сессии нужно подключение к серверу');
                }
              }}
            >
              <LogOut size={17} />
              Выйти из аккаунта
            </button>
          </section>
        </div>
      )}
    </div>
  );
}
function ListIcon() {
  return <CheckSquare size={18} />;
}
function TaskRows({
  tasks,
  workspace,
}: {
  tasks: ReturnType<Workspace['getTasks']>;
  workspace: Workspace;
}) {
  return (
    <div className="task-rows">
      {tasks.map((task) => (
        <div className={`task-row ${task.checked ? 'done' : ''}`} key={`${task.noteId}:${task.id}`}>
          <label className="task-checkbox">
            <input
              type="checkbox"
              checked={task.checked}
              aria-label={`Выполнить: ${task.text || 'задача'}`}
              onChange={(e) => {
                setTaskChecked(workspace.note(task.noteId).doc, task.id, e.target.checked);
                workspace.update(task.noteId, {});
              }}
            />
          </label>
          <button className="task-text" onClick={() => useUI.getState().select(task.noteId)}>
            <span>{task.text || 'Без названия'}</span>
            <small>{task.noteTitle}</small>
          </button>
          {task.due && <Due due={task.due} />}
        </div>
      ))}
    </div>
  );
}
function EditDialog({ dialog, close }: { dialog: Dialog; close: () => void }) {
  const [value, setValue] = useState(dialog.value);
  const [color, setColor] = useState(dialog.color || colors[0]);
  return (
    <div className="modal-backdrop" onClick={close}>
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          dialog.action(value.trim(), color);
          close();
        }}
      >
        <h2 id="dialog-title">{dialog.title}</h2>
        {dialog.danger ? (
          <p>{dialog.label}</p>
        ) : (
          <label>
            {dialog.label}
            <input
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              required
              maxLength={100}
            />
          </label>
        )}
        {dialog.color && (
          <div className="color-options">
            {colors.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`Цвет ${c}`}
                aria-pressed={color === c}
                style={{ background: c }}
                onClick={() => setColor(c)}
              >
                {color === c && <Check size={18} />}
              </button>
            ))}
            <ColorPicker value={color} onChange={setColor} label="Выбрать другой цвет" />
          </div>
        )}
        <div className="actions">
          <button type="button" onClick={close}>
            Отмена
          </button>
          <button
            className={dialog.danger ? 'danger' : 'primary'}
            disabled={!dialog.danger && !value.trim()}
          >
            {dialog.confirm || (dialog.danger ? 'Удалить' : 'Готово')}
          </button>
        </div>
      </form>
    </div>
  );
}

import { MembersDialog, Invitations, NotePresence } from './Collaboration';
import { ColorPicker } from './ColorPicker';
import { NotebookIcon, NotebookIconPicker } from './NotebookIcon';
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
  Menu,
  X,
  Pin,
  ArchiveRestore,
  Clock3,
  MoreHorizontal,
  Tag,
  ArrowLeft,
  Check,
  Sun,
  NotebookPen,
  Star,
  Lock,
  LockOpen,
  Share2,
  FolderInput,
} from 'lucide-react';
import MiniSearch from 'minisearch';
import {
  localDate,
  dueDay,
  setTaskChecked,
  snippet,
  type Note,
  type Notebook,
  type Section,
  type SnippetPart,
} from '@selfnote/shared';
import { applyAppearance, storedAppearance, type Theme } from './theme';
import { PasswordDialog, type PasswordMode } from './NoteSecurity';
import { ShareDialog } from './Share';
import { api, refresh, setToken, type User } from './api';
import { Auth } from './Auth';
import { SettingsNav, SettingsPane, initials } from './Settings';
import { Workspace, useUI } from './store';
import { NoteEditor, Due } from './Editor';
import { flushImages } from './attachments';
const colors = ['#C2410C', '#3451D1', '#2B7A3D', '#7A3DB8'];
const NOTE_TYPE = 'application/x-selfnote-note';
interface Dialog {
  title: string;
  value: string;
  label: string;
  danger?: boolean;
  confirm?: string;
  action: (value: string, color: string, icon: string) => void;
  color?: string;
  icon?: string;
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
      onUserChange={(value) => {
        localStorage.setItem('selfnote-user', JSON.stringify(value));
        setUser(value);
      }}
      onLogout={() => {
        setUser(null);
        localStorage.removeItem('selfnote-user');
        setToken('');
      }}
    />
  );
}
function Shell({
  user,
  onLogout,
  onUserChange,
}: {
  user: User;
  onLogout: () => void;
  onUserChange: (user: User) => void;
}) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  useEffect(() => {
    const next = new Workspace(user.id);
    setWorkspace(next);
    return () => next.destroy();
  }, [user.id]);
  return workspace ? (
    <WorkspaceShell
      user={user}
      onLogout={onLogout}
      onUserChange={onUserChange}
      workspace={workspace}
    />
  ) : (
    <div className="loading">Открываем локальную базу…</div>
  );
}
function WorkspaceShell({
  user,
  onLogout,
  onUserChange,
  workspace,
}: {
  user: User;
  onLogout: () => void;
  onUserChange: (user: User) => void;
  workspace: Workspace;
}) {
  const revision = useSyncExternalStore(workspace.subscribe, workspace.snapshot);
  const ui = useUI();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => new Set(JSON.parse(localStorage.getItem(`collapsed:${user.id}`) || '[]')),
  );
  const [more, setMore] = useState(false);
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
        setMore(false);
        closeMenus();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [workspace]);
  // Выпадающие меню закрываются кликом мимо них и после выбора пункта.
  useEffect(() => {
    const outside = (e: PointerEvent) => {
      const target = e.target as Element;
      closeMenus(target.closest('details.row-menu'));
      if (!target.closest('.menu-wrap')) setMore(false);
    };
    const picked = (e: MouseEvent) => {
      if ((e.target as Element).closest('details.row-menu .popover button')) closeMenus();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('click', picked);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('click', picked);
    };
  }, []);
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
  const [appearance, setAppearanceState] = useState(storedAppearance);
  const [password, setPassword] = useState<PasswordMode | null>(null);
  const [sharing, setSharing] = useState(false);
  const [members, setMembers] = useState(false);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [remote, setRemote] = useState<{ id: string; parts: SnippetPart[] | null }[]>([]);
  const [sharedIds, setSharedIds] = useState<Set<string>>(
    () => new Set(JSON.parse(localStorage.getItem(`shared:${user.id}`) || '[]')),
  );
  function setAppearance(theme: Theme, accent: string) {
    applyAppearance(theme, accent);
    setAppearanceState({ theme, accent });
    workspace.setAppearance(theme, accent);
  }
  // оформление, выбранное на другом устройстве, приходит через документ пространства
  const synced = workspace.appearance;
  useEffect(() => {
    if (!synced.theme || !synced.accent) return;
    const local = storedAppearance();
    if (local.theme === synced.theme && local.accent === synced.accent) return;
    applyAppearance(synced.theme, synced.accent);
    setAppearanceState({ theme: synced.theme, accent: synced.accent });
  }, [synced.theme, synced.accent]);
  // серверный поиск дополняет локальный: находит заметки, ещё не загруженные на устройство
  useEffect(() => {
    const query = ui.query.trim();
    if (!query || !navigator.onLine) {
      setRemote([]);
      return;
    }
    let active = true;
    const timer = setTimeout(() => {
      api<{ id: string; parts: SnippetPart[] | null }[]>(
        `/api/search?q=${encodeURIComponent(query)}`,
      )
        .then((rows) => active && setRemote(rows))
        .catch(() => active && setRemote([]));
    }, 300);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [ui.query]);
  const refreshShared = async () => {
    try {
      const rows = await api<{ note_id: string }[]>('/api/shares');
      const ids = new Set(rows.map((r) => r.note_id));
      setSharedIds(ids);
      localStorage.setItem(`shared:${user.id}`, JSON.stringify([...ids]));
    } catch {
      /* офлайн — показываем последний известный список */
    }
  };
  useEffect(() => {
    if (ui.filter === 'shared') {
      void refreshShared();
      void workspace.refreshCollaboration();
    }
  }, [ui.filter]);
  useEffect(() => {
    if (!menu) return;
    const close = (e: PointerEvent) => {
      if (!(e.target as Element).closest('.context-menu')) setMenu(null);
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(null);
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', key);
    };
  }, [menu]);
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
        title:
          n.encrypted && n.hideTitle && !workspace.secure.isUnlocked(n.id)
            ? ''
            : workspace.title(n),
        text: workspace.extract(n.id).plainText,
        tags: n.tags.join(' '),
      })),
    );
    return search;
  }, [workspace, revision, searching]);
  const remoteParts = new Map(remote.map((r) => [r.id, r.parts]));
  const matches =
    index && ui.query
      ? new Set([...index.search(ui.query).map((r) => r.id), ...remoteParts.keys()])
      : null;
  const filtered = notes
    .filter((n) => (ui.filter === 'trash' ? Boolean(n.deletedAt) : !n.deletedAt))
    .filter((n) => !matches || matches.has(n.id))
    .filter(
      (n) =>
        ['all', 'trash'].includes(ui.filter) ||
        (ui.filter === 'tasks' && workspace.extract(n.id).tasks.length > 0) ||
        (ui.filter === 'favorites' && Boolean(n.favorite)) ||
        (ui.filter === 'shared' && (sharedIds.has(n.id) || workspace.isCollaborative(n.id))) ||
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
        : ui.filter === 'favorites'
          ? 'Избранное'
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
      title: book ? 'Настройки книжки' : 'Новая записная книжка',
      label: 'Название',
      value: book?.name || '',
      color: book?.color || colors[notebooks.length % colors.length],
      icon: book?.icon || 'book',
      action: (name, color, icon) => {
        const id = book?.id || uuid();
        workspace.notebooks.set(id, { ...book, id, name, color, icon });
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
  function moveNote(id: string, notebookId: string | null, sectionId: string | null) {
    if (!workspace.isOwner(id)) return;
    workspace.update(id, { notebookId, sectionId });
    const where = sectionId
      ? workspace.sections.get(sectionId)?.name
      : notebookId
        ? workspace.notebooks.get(notebookId)?.name
        : 'Без книжки';
    ui.toast(`Заметка перенесена: ${where}`);
  }
  function toTrash(id: string) {
    workspace.update(id, { deletedAt: new Date().toISOString() });
    if (ui.selected === id) ui.select(null);
  }
  /** Цель для перетаскивания заметки из списка. */
  const dropProps = (target: string, action: (id: string) => void) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(NOTE_TYPE)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setDropTarget(target);
    },
    onDragLeave: () => setDropTarget((t) => (t === target ? null : t)),
    onDrop: (e: React.DragEvent) => {
      const id = e.dataTransfer.getData(NOTE_TYPE);
      setDropTarget(null);
      if (!id || !workspace.metadata.has(id)) return;
      e.preventDefault();
      action(id);
    },
  });
  const drop = (target: string) => (dropTarget === target ? 'drop-target' : '');
  // на странице настроек ни один раздел заметок не подсвечивается
  const active = ui.settings ? null : ui.filter;
  const nav = (
    filter: string,
    label: string,
    Icon: typeof FileText,
    badge?: string | number,
    onDropNote?: (id: string) => void,
  ) => (
    <button
      className={`nav-item ${active === filter ? 'selected' : ''} ${drop(filter)}`}
      {...(onDropNote ? dropProps(filter, onDropNote) : {})}
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
            {nav(
              'favorites',
              'Избранное',
              Star,
              notes.filter((n) => !n.deletedAt && n.favorite).length || undefined,
              (id) => {
                workspace.update(id, { favorite: true });
                ui.toast('Добавлено в избранное');
              },
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
              <div
                className={`book-row ${active === book.id ? 'selected' : ''} ${drop(book.id)}`}
                {...dropProps(book.id, (id) => moveNote(id, book.id, null))}
              >
                <button className="book-name" onClick={() => ui.setFilter(book.id)}>
                  <span
                    className="book-icon"
                    style={{ color: book.color, background: `${book.color}12` }}
                  >
                    <NotebookIcon name={book.icon} />
                  </span>
                  <span>{book.name}</span>
                  <small>
                    {notes.filter((n) => !n.deletedAt && n.notebookId === book.id).length}
                  </small>
                </button>
                {sections.some((s) => s.notebookId === book.id) && (
                  <button
                    className="collapse-button"
                    aria-label={collapsed.has(book.id) ? 'Развернуть книжку' : 'Свернуть книжку'}
                    onClick={() => toggleCollapse(book.id)}
                  >
                    {collapsed.has(book.id) ? (
                      <ChevronRight size={14} />
                    ) : (
                      <ChevronDown size={14} />
                    )}
                  </button>
                )}
                <details className="row-menu">
                  <summary aria-label={`Действия с книжкой ${book.name}`}>
                    <MoreHorizontal size={15} />
                  </summary>
                  <div className="popover">
                    <button onClick={() => editNotebook(book)}>Настройки книжки</button>
                    <button onClick={() => editSection(book.id)}>Добавить подраздел</button>
                    <button className="danger-text" onClick={() => removeNotebook(book)}>
                      Удалить
                    </button>
                  </div>
                </details>
              </div>
              {!collapsed.has(book.id) && sections.some((s) => s.notebookId === book.id) && (
                <div className="subsections">
                  {sections
                    .filter((s) => s.notebookId === book.id)
                    .map((section) => (
                      <div
                        key={section.id}
                        className={`subsection-row ${drop(section.id)}`}
                        {...dropProps(section.id, (id) => moveNote(id, book.id, section.id))}
                      >
                        <button
                          className={active === section.id ? 'selected' : ''}
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
                className={active === `tag:${tag}` ? 'active' : ''}
                onClick={() => ui.setFilter(`tag:${tag}`)}
              >
                #{tag}
              </button>
            ))}
            {!workspace.tags.size && (
              <button className="add-tag" onClick={addTag}>+ Добавить метку</button>
            )}
          </div>
        </div>
        <div className="sidebar-bottom">
          {nav('trash', 'Корзина', Trash2, undefined, toTrash)}
          <button
            className={`nav-item ${ui.settings ? 'selected' : ''}`}
            onClick={() => ui.openSettings(ui.settings ?? 'profile', 'list')}
          >
            <Settings2 size={18} />
            Настройки
          </button>
          <button className="profile" onClick={() => ui.openSettings('profile')}>
            <span className="avatar">{initials(user.name)}</span>
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
      {ui.settings ? (
        <SettingsNav user={user} />
      ) : (
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
            {ui.filter === 'shared' && <Invitations workspace={workspace} />}
            {groupList.map(([group, items]) => (
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
                    draggable={workspace.isOwner(note.id)}
                    onDragStart={(e) => {
                      e.dataTransfer.setData(NOTE_TYPE, note.id);
                      e.dataTransfer.effectAllowed = 'move';
                    }}
                    onDragEnd={() => setDropTarget(null)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      if (!workspace.isOwner(note.id)) return;
                      const rect = e.currentTarget.getBoundingClientRect();
                      // с клавиатуры (Shift+F10, клавиша меню) координат нет — берём строку
                      const keyboard = e.clientX === 0 && e.clientY === 0;
                      setMenu({
                        id: note.id,
                        x: keyboard ? rect.left + 24 : e.clientX,
                        y: keyboard ? rect.top + 24 : e.clientY,
                      });
                    }}
                    aria-haspopup="menu"
                  >
                    <span className="note-row-top">
                      <strong>
                        {note.encrypted && <Lock size={13} aria-label="Под паролем" />}
                        {workspace.title(note)}
                      </strong>
                      <time>
                        {new Date(note.updatedAt).toLocaleTimeString('ru', {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </time>
                    </span>
                    <span className="note-preview">
                      <Preview
                        workspace={workspace}
                        note={note}
                        query={ui.query}
                        remote={remoteParts.get(note.id)}
                      />
                    </span>
                  </button>
                ))}
              </section>
            ))}
            {!filtered.length && ui.filter === 'shared' && !ui.query && (
              <div className="empty">
                <Users size={30} />
                <h3>Пока нет общих заметок</h3>
                <p>
                  Откройте заметку и нажмите «Совместный доступ», чтобы пригласить пользователя, или
                  «Поделиться» для публичной ссылки.
                </p>
              </div>
            )}
            {!filtered.length && ui.filter === 'favorites' && !ui.query && (
              <div className="empty">
                <Star size={30} />
                <h3>В избранном пусто</h3>
                <p>Отметьте заметку звёздочкой или перетащите её сюда.</p>
              </div>
            )}
            {!filtered.length && (ui.query || !['shared', 'favorites'].includes(ui.filter)) && (
              <div className="empty">
                <FileText size={30} />
                <h3>
                  {ui.query
                    ? 'Ничего не найдено'
                    : ui.filter === 'trash'
                      ? 'Корзина пуста'
                      : ui.filter === 'tasks'
                        ? 'Заметок с задачами пока нет'
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
      )}
      <main className="editor-panel panel">
        {ui.settings ? (
          <SettingsPane
            user={user}
            workspace={workspace}
            appearance={appearance}
            setAppearance={setAppearance}
            onUserChange={onUserChange}
            onLogout={onLogout}
          />
        ) : selected ? (
          <>
            <header className="editor-header">
              <div className="breadcrumb">
                <NotebookIcon
                  name={
                    selected.notebookId
                      ? workspace.notebooks.get(selected.notebookId)?.icon
                      : undefined
                  }
                />
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
              <time className="modified" dateTime={new Date(selected.updatedAt).toISOString()}>
                Изменено{' '}
                {new Date(selected.updatedAt).toLocaleDateString('ru', {
                  day: '2-digit',
                  month: '2-digit',
                  year: 'numeric',
                })}{' '}
                в{' '}
                {new Date(selected.updatedAt).toLocaleTimeString('ru', {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </time>
              <div className="editor-actions">
                {!selected.encrypted && workspace.isOwner(selected.id) && (
                  <button
                    className="icon-button"
                    title="Совместный доступ"
                    aria-label="Совместный доступ"
                    disabled={Boolean(selected.deletedAt)}
                    onClick={() => setMembers(true)}
                  >
                    <Users size={18} />
                  </button>
                )}
                {!selected.encrypted && (
                  <button
                    aria-label="История"
                    title="История"
                    onClick={() => setHistory((v) => !v)}
                  >
                    История
                  </button>
                )}
                {selected.encrypted ? (
                  workspace.secure.isUnlocked(selected.id) && (
                    <button
                      className="icon-button active"
                      title="Заблокировать заметку"
                      aria-label="Заблокировать заметку"
                      onClick={() => workspace.secure.lock(selected.id)}
                    >
                      <LockOpen size={18} />
                    </button>
                  )
                ) : (
                  <button
                    className="icon-button"
                    title="Пароль на заметку"
                    aria-label="Пароль на заметку"
                    disabled={Boolean(selected.deletedAt) || !workspace.isOwner(selected.id)}
                    onClick={() => setPassword('set')}
                  >
                    <Lock size={18} />
                  </button>
                )}
                <button
                  className="icon-button"
                  title="Поделиться"
                  aria-label="Поделиться"
                  disabled={Boolean(selected.deletedAt) || !workspace.isOwner(selected.id)}
                  onClick={() => setSharing(true)}
                >
                  <Share2 size={18} />
                </button>
                <button
                  className={`icon-button ${selected.favorite ? 'active' : ''}`}
                  aria-label={selected.favorite ? 'Убрать из избранного' : 'В избранное'}
                  title={selected.favorite ? 'Убрать из избранного' : 'В избранное'}
                  aria-pressed={Boolean(selected.favorite)}
                  disabled={!workspace.isOwner(selected.id)}
                  onClick={() => workspace.update(selected.id, { favorite: !selected.favorite })}
                >
                  <Star size={18} fill={selected.favorite ? 'currentColor' : 'none'} />
                </button>
                {!selected.encrypted && (
                  <button
                    className="icon-button"
                    title="Сохранить версию"
                    aria-label="Сохранить версию"
                    disabled={!workspace.canEdit(selected.id)}
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
                )}
                <button
                  className={`icon-button ${selected.pinned ? 'active' : ''}`}
                  aria-label={selected.pinned ? 'Открепить заметку' : 'Закрепить заметку'}
                  disabled={!workspace.isOwner(selected.id)}
                  onClick={() => workspace.update(selected.id, { pinned: !selected.pinned })}
                >
                  <Pin size={17} />
                </button>
                <div className="menu-wrap">
                  <button
                    className="icon-button"
                    aria-label="Действия с заметкой"
                    disabled={!workspace.isOwner(selected.id)}
                    onClick={() => setMore(!more)}
                  >
                    <MoreHorizontal size={19} />
                  </button>
                  {more && workspace.isOwner(selected.id) && (
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
                      {selected.encrypted && workspace.secure.isUnlocked(selected.id) && (
                        <>
                          <button
                            onClick={() => {
                              setPassword('change');
                              setMore(false);
                            }}
                          >
                            <Lock size={16} />
                            Сменить пароль
                          </button>
                          <button
                            onClick={() => {
                              setPassword('remove');
                              setMore(false);
                            }}
                          >
                            <LockOpen size={16} />
                            Снять пароль
                          </button>
                        </>
                      )}
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
            {!selected.encrypted && (
              <NotePresence
                key={selected.id}
                workspace={workspace}
                id={selected.id}
                name={user.name}
              />
            )}
            {!workspace.isOwner(selected.id) && (
              <div className="collaboration-banner">
                <span>
                  {
                    workspace.collaboration.notes.find((row) => row.note.id === selected.id)
                      ?.ownerName
                  }{' '}
                  · {workspace.canEdit(selected.id) ? 'Вы редактор' : 'Только чтение'}
                </span>
                <button
                  onClick={async () => {
                    if (
                      !window.confirm(
                        'Покинуть общую заметку? Для возврата потребуется новое приглашение.',
                      )
                    )
                      return;
                    try {
                      await api(`/api/notes/${selected.id}/members/${user.id}`, {
                        method: 'DELETE',
                      });
                      await workspace.refreshCollaboration();
                    } catch (e) {
                      ui.toast((e as Error).message);
                    }
                  }}
                >
                  Покинуть
                </button>
              </div>
            )}
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
            {history && !selected.encrypted && (
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
            <QuickTask workspace={workspace} due={null} placeholder="Новая задача во «Входящие»" />
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
                const sorted =
                  group === 'Без срока'
                    ? [...items].sort(
                        (a, b) =>
                          (a.order ?? 1e6 + a.position) - (b.order ?? 1e6 + b.position) ||
                          a.noteTitle.localeCompare(b.noteTitle),
                      )
                    : [...items].sort((a, b) => (a.due ?? '').localeCompare(b.due ?? ''));
                return (
                  <div className="task-group" key={group}>
                    <h2>
                      {group}
                      <small>{items.length}</small>
                    </h2>
                    <TaskRows
                      tasks={sorted}
                      workspace={workspace}
                      sortable={group === 'Без срока'}
                    />
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
                <QuickTask
                  workspace={workspace}
                  due={localDate()}
                  placeholder="Добавить задачу на сегодня"
                />
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
      {dialog && <EditDialog dialog={dialog} close={() => setDialog(null)} />}
      {password && selected && (
        <PasswordDialog
          workspace={workspace}
          note={selected}
          mode={password}
          close={() => setPassword(null)}
        />
      )}
      {members && selected && workspace.isOwner(selected.id) && !selected.encrypted && (
        <MembersDialog workspace={workspace} id={selected.id} close={() => setMembers(false)} />
      )}
      {sharing && selected && workspace.isOwner(selected.id) && (
        <ShareDialog
          workspace={workspace}
          note={selected}
          close={() => {
            setSharing(false);
            void refreshShared();
          }}
        />
      )}
      {menu && workspace.metadata.get(menu.id) && (
        <NoteMenu
          note={workspace.metadata.get(menu.id)!}
          x={menu.x}
          y={menu.y}
          notebooks={notebooks}
          sections={sections}
          close={() => setMenu(null)}
          workspace={workspace}
          onMove={moveNote}
          onTrash={toTrash}
        />
      )}
    </div>
  );
}
/** Контекстное меню строки списка заметок (правая кнопка, Shift+F10). */
function NoteMenu({
  note,
  x,
  y,
  notebooks,
  sections,
  workspace,
  close,
  onMove,
  onTrash,
}: {
  note: Note;
  x: number;
  y: number;
  notebooks: Notebook[];
  sections: Section[];
  workspace: Workspace;
  close: () => void;
  onMove: (id: string, notebookId: string | null, sectionId: string | null) => void;
  onTrash: (id: string) => void;
}) {
  const [moving, setMoving] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector('button')?.focus();
  }, [moving]);
  const left = Math.min(x, window.innerWidth - 260);
  const top = Math.min(y, window.innerHeight - (moving ? 360 : 240));
  const act = (fn: () => void) => () => {
    fn();
    close();
  };
  return (
    <div
      ref={ref}
      className="popover context-menu"
      role="menu"
      style={{ left: Math.max(8, left), top: Math.max(8, top) }}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        e.preventDefault();
        const items = [...(ref.current?.querySelectorAll('button') ?? [])];
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        items[(index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
      }}
    >
      {moving ? (
        <>
          <button role="menuitem" onClick={() => setMoving(false)}>
            <ArrowLeft size={16} />
            Назад
          </button>
          <button role="menuitem" onClick={act(() => onMove(note.id, null, null))}>
            Без книжки
          </button>
          {notebooks.map((book) => (
            <div key={book.id}>
              <button role="menuitem" onClick={act(() => onMove(note.id, book.id, null))}>
                <span style={{ color: book.color }}>
                  <NotebookIcon name={book.icon} size={15} />
                </span>
                {book.name}
              </button>
              {sections
                .filter((s) => s.notebookId === book.id)
                .map((section) => (
                  <button
                    key={section.id}
                    role="menuitem"
                    className="menu-indent"
                    onClick={act(() => onMove(note.id, book.id, section.id))}
                  >
                    {section.name}
                  </button>
                ))}
            </div>
          ))}
        </>
      ) : note.deletedAt ? (
        <>
          <button
            role="menuitem"
            onClick={act(() => workspace.update(note.id, { deletedAt: null }))}
          >
            <ArchiveRestore size={16} />
            Восстановить
          </button>
          <button
            role="menuitem"
            className="danger-text"
            onClick={act(() => {
              if (window.confirm('Удалить заметку навсегда? Восстановить её будет невозможно.'))
                workspace.deleteForever([note.id]);
            })}
          >
            <Trash2 size={16} />
            Удалить навсегда
          </button>
        </>
      ) : (
        <>
          <button
            role="menuitem"
            onClick={act(() => workspace.update(note.id, { pinned: !note.pinned }))}
          >
            <Pin size={16} />
            {note.pinned ? 'Открепить' : 'Закрепить'}
          </button>
          <button
            role="menuitem"
            onClick={act(() => workspace.update(note.id, { favorite: !note.favorite }))}
          >
            <Star size={16} />
            {note.favorite ? 'Убрать из избранного' : 'В избранное'}
          </button>
          <button role="menuitem" onClick={() => setMoving(true)}>
            <FolderInput size={16} />
            Переместить…
          </button>
          <button role="menuitem" className="danger-text" onClick={act(() => onTrash(note.id))}>
            <Trash2 size={16} />В корзину
          </button>
        </>
      )}
    </div>
  );
}
/** Закрыть открытые меню «…» в навигации, кроме keep. */
function closeMenus(keep?: Element | null) {
  for (const menu of document.querySelectorAll('details.row-menu[open]'))
    if (menu !== keep) menu.removeAttribute('open');
}
function ListIcon() {
  return <CheckSquare size={18} />;
}
type TaskItem = ReturnType<Workspace['getTasks']>[number];
function TaskRows({
  tasks,
  workspace,
  sortable = false,
}: {
  tasks: TaskItem[];
  workspace: Workspace;
  sortable?: boolean;
}) {
  const [dragging, setDragging] = useState<string | null>(null);
  const keyOf = (t: TaskItem) => `${t.noteId}:${t.id}`;
  const move = (from: number, to: number) => {
    if (to < 0 || to >= tasks.length || from === to) return;
    const keys = tasks.map(keyOf);
    const [item] = keys.splice(from, 1);
    keys.splice(to, 0, item);
    workspace.setTaskOrder(keys);
  };
  return (
    <div className="task-rows">
      {tasks.map((task, index) => (
        <div
          className={`task-row ${task.checked ? 'done' : ''} ${dragging === keyOf(task) ? 'dragging' : ''}`}
          key={keyOf(task)}
          draggable={sortable}
          onDragStart={(e) => {
            setDragging(keyOf(task));
            e.dataTransfer.setData('text/x-selfnote-task', String(index));
            e.dataTransfer.effectAllowed = 'move';
          }}
          onDragEnd={() => setDragging(null)}
          onDragOver={(e) => {
            if (sortable && e.dataTransfer.types.includes('text/x-selfnote-task'))
              e.preventDefault();
          }}
          onDrop={(e) => {
            const from = Number(e.dataTransfer.getData('text/x-selfnote-task'));
            if (Number.isInteger(from)) move(from, index);
            setDragging(null);
          }}
          onKeyDown={(e) => {
            // порядок с клавиатуры: Alt + стрелки
            if (!sortable || !e.altKey) return;
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              move(index, index - 1);
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              move(index, index + 1);
            }
          }}
          title={sortable ? 'Перетащите или Alt + ↑/↓, чтобы изменить порядок' : undefined}
        >
          <label className="task-checkbox">
            <input
              type="checkbox"
              checked={task.checked}
              disabled={!workspace.canEdit(task.noteId)}
              aria-label={`Выполнить: ${task.text || 'задача'}`}
              onChange={(e) => {
                if (!workspace.canEdit(task.noteId)) return;
                const doc = workspace.noteDoc(task.noteId);
                if (!doc) return;
                setTaskChecked(doc, task.id, e.target.checked);
                workspace.update(task.noteId, {});
              }}
            />
          </label>
          <button className="task-text" onClick={() => useUI.getState().select(task.noteId)}>
            <span>{task.text || 'Без названия'}</span>
            <small>{task.noteTitle}</small>
          </button>
          {task.due && <Due due={task.due} repeat={task.repeat} />}
        </div>
      ))}
    </div>
  );
}
/** Быстрое добавление задачи в заметку «Входящие». */
function QuickTask({
  workspace,
  due,
  placeholder,
}: {
  workspace: Workspace;
  due: string | null;
  placeholder: string;
}) {
  const [text, setText] = useState('');
  return (
    <form
      className="quick-task"
      onSubmit={(e) => {
        e.preventDefault();
        const value = text.trim();
        if (!value) return;
        setText('');
        void workspace.quickTask(value, due);
      }}
    >
      <Plus size={17} aria-hidden="true" />
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        maxLength={500}
      />
      {text.trim() && (
        <button type="submit" className="text-button">
          Добавить
        </button>
      )}
    </form>
  );
}
/** Строка описания в списке: при поиске — фрагмент с подсветкой совпадения. */
function Preview({
  workspace,
  note,
  query,
  remote,
}: {
  workspace: Workspace;
  note: Note;
  query: string;
  remote?: SnippetPart[] | null;
}) {
  if (note.encrypted && !workspace.secure.isUnlocked(note.id)) return <>Содержимое зашифровано</>;
  const text = workspace.extract(note.id).plainText;
  const parts = query ? (snippet(text, query) ?? remote ?? null) : null;
  if (parts)
    return (
      <>{parts.map((part, i) => (part.mark ? <mark key={i}>{part.text}</mark> : part.text))}</>
    );
  return <>{text.replace(/\n/g, ' ') || 'Пока здесь чистый лист'}</>;
}
function EditDialog({ dialog, close }: { dialog: Dialog; close: () => void }) {
  const [value, setValue] = useState(dialog.value);
  const [color, setColor] = useState(dialog.color || colors[0]);
  const [icon, setIcon] = useState(dialog.icon || 'book');
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
          dialog.action(value.trim(), color, icon);
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
        {dialog.icon !== undefined && <NotebookIconPicker value={icon} onChange={setIcon} />}
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

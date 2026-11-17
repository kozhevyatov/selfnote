import { yDocToProsemirrorJSON, ySyncPluginKey } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import { uuid } from './ids';
import { useEffect, useState, useRef } from 'react';
import {
  useEditor,
  EditorContent,
  ReactNodeViewRenderer,
  NodeViewWrapper,
  NodeViewContent,
  type NodeViewProps,
} from '@tiptap/react';
import { Mark, mergeAttributes, Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Image from '@tiptap/extension-image';
import {
  Bold,
  Italic,
  Strikethrough,
  EyeOff,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  ListTodo,
  Link,
  ImagePlus,
  Undo2,
  Redo2,
  CalendarDays,
  Repeat,
  Lock,
} from 'lucide-react';
import {
  checkTaskAttributes,
  dueDay,
  firstDue,
  formatRepeat,
  localDate,
  parseRepeat,
  repeatLabel,
  WEEK_DAY_SHORT,
  WrongPasswordError,
} from '@selfnote/shared';
import { secureTitle } from './secure';
import { storeImage, imageUrl, flushImages } from './attachments';
import { Workspace, useUI } from './store';
export function dueLabel(due: string) {
  const day = dueDay(due),
    today = localDate();
  const label = new Date(`${day}T12:00:00`).toLocaleDateString('ru', {
    day: 'numeric',
    month: 'short',
  });
  return day === today ? 'Сегодня' : day < today ? `Просрочено · ${label}` : label;
}
export function Due({ due, repeat }: { due: string; repeat?: string | null }) {
  const label = repeatLabel(repeat);
  return (
    <span
      className={`due ${dueDay(due) < localDate() ? 'overdue' : dueDay(due) === localDate() ? 'today' : ''}`}
      title={label || undefined}
    >
      {label && <Repeat size={12} aria-label={label} />}
      {dueLabel(due)}
    </span>
  );
}
const REPEAT_OPTIONS = [
  { label: 'Не повторять', rule: '' },
  { label: 'Каждый день', rule: 'FREQ=DAILY' },
  { label: 'По будням', rule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' },
  { label: 'Каждую неделю', rule: 'weekly' },
  { label: 'Каждый месяц', rule: 'FREQ=MONTHLY' },
];
/** Выбор повтора задачи: готовые варианты и дни недели. */
function RepeatPicker({
  due,
  repeat,
  onChange,
  disabled,
}: {
  due: string | null;
  repeat: string | null;
  onChange: (attrs: { repeat: string | null; due?: string | null }) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', key);
    };
  }, [open]);
  const current = parseRepeat(repeat);
  const today = localDate();
  const set = (rule: string) => {
    if (!rule) return onChange({ repeat: null });
    if (rule === 'weekly') {
      const day = (new Date(`${due ? dueDay(due) : today}T12:00:00`).getDay() + 6) % 7;
      rule = formatRepeat({ freq: 'WEEKLY', days: [day] });
    }
    // повтор без срока: срок — ближайший подходящий день
    onChange({ repeat: rule, ...(due ? {} : { due: firstDue(rule, today) }) });
  };
  const toggleDay = (day: number) => {
    const days = new Set(current?.freq === 'WEEKLY' ? current.days : []);
    if (days.has(day)) days.delete(day);
    else days.add(day);
    if (!days.size) return onChange({ repeat: null });
    const rule = formatRepeat({ freq: 'WEEKLY', days: [...days] });
    onChange({ repeat: rule, ...(due ? {} : { due: firstDue(rule, today) }) });
  };
  return (
    <span className="task-repeat" ref={wrap} contentEditable={false}>
      <button
        type="button"
        className={`icon-button ${current ? 'active' : ''}`}
        disabled={disabled}
        title={repeatLabel(repeat) || 'Повтор'}
        aria-label={repeatLabel(repeat) ? `Повтор: ${repeatLabel(repeat)}` : 'Настроить повтор'}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Repeat size={15} />
      </button>
      {open && (
        <span className="popover repeat-popover" role="dialog" aria-label="Повтор задачи">
          {REPEAT_OPTIONS.map((option) => {
            const selected =
              option.rule === 'weekly'
                ? current?.freq === 'WEEKLY' && repeat !== REPEAT_OPTIONS[2].rule
                : option.rule
                  ? repeat === option.rule
                  : !current;
            return (
              <button
                key={option.label}
                type="button"
                className={selected ? 'selected' : ''}
                aria-pressed={selected}
                onClick={() => {
                  set(option.rule);
                  if (option.rule !== 'weekly') setOpen(false);
                }}
              >
                {option.label}
              </button>
            );
          })}
          {current?.freq === 'WEEKLY' && (
            <span className="week-days" role="group" aria-label="Дни недели">
              {WEEK_DAY_SHORT.map((label, day) => (
                <button
                  key={label}
                  type="button"
                  aria-pressed={current.days.includes(day)}
                  className={current.days.includes(day) ? 'selected' : ''}
                  onClick={() => toggleDay(day)}
                >
                  {label}
                </button>
              ))}
            </span>
          )}
        </span>
      )}
    </span>
  );
}
const Spoiler = Mark.create({
  name: 'spoiler',
  parseHTML: () => [{ tag: 'span[data-spoiler]' }],
  renderHTML: ({ HTMLAttributes }) => [
    'span',
    mergeAttributes(HTMLAttributes, {
      'data-spoiler': '',
      class: 'spoiler',
      tabindex: '0',
      role: 'button',
      'aria-label': 'Показать скрытый текст',
    }),
    0,
  ],
});
function TaskView({ node, updateAttributes, editor }: NodeViewProps) {
  return (
    <NodeViewWrapper
      as="li"
      className={`task-item ${node.attrs.checked ? 'checked' : ''}`}
      data-type="taskItem"
    >
      <label contentEditable={false} className="task-checkbox">
        <input
          disabled={!editor.isEditable}
          type="checkbox"
          checked={Boolean(node.attrs.checked)}
          aria-label={`Выполнить: ${node.textContent || 'задача'}`}
          onChange={(e) =>
            updateAttributes(checkTaskAttributes(node.attrs, e.target.checked, localDate()))
          }
        />
      </label>
      <NodeViewContent className="task-content" />
      <RepeatPicker
        due={node.attrs.due}
        repeat={node.attrs.repeat}
        disabled={!editor.isEditable}
        onChange={(attrs) => updateAttributes(attrs)}
      />
      <label className="task-date" contentEditable={false} title="Срок задачи">
        {node.attrs.due ? (
          <Due due={node.attrs.due} repeat={node.attrs.repeat} />
        ) : (
          <CalendarDays size={16} />
        )}
        <input
          disabled={!editor.isEditable}
          aria-label="Срок задачи"
          type="date"
          value={node.attrs.due?.slice(0, 10) || ''}
          onInput={(e) => updateAttributes({ due: e.currentTarget.value || null })}
          onBlur={(e) => {
            if ((e.currentTarget.value || null) !== node.attrs.due)
              updateAttributes({ due: e.currentTarget.value || null });
          }}
          onChange={(e) => updateAttributes({ due: e.target.value || null })}
        />
      </label>
    </NodeViewWrapper>
  );
}
const Tasks = TaskItem.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      id: { default: null, keepOnSplit: false },
      due: { default: null, keepOnSplit: false },
      doneAt: { default: null, keepOnSplit: false },
      repeat: { default: null, keepOnSplit: false },
    };
  },
  addNodeView() {
    return ReactNodeViewRenderer(TaskView);
  },
});
const NORMALIZE = 'selfnote-normalize';
const TaskIds = Extension.create({
  name: 'taskIds',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction: (_transactions, _old, state) => {
          if (!this.editor.isEditable) return null;
          const ids = new Set<string>();
          const tr = state.tr;
          state.doc.descendants((node, pos) => {
            if (node.type.name !== 'taskItem') return;
            const id = node.attrs.id;
            if (!id || ids.has(id)) {
              const fresh = uuid();
              tr.setNodeMarkup(pos, undefined, { ...node.attrs, id: fresh });
              ids.add(fresh);
            } else ids.add(id);
          });
          // Служебная правка (выдача id задачам) — не правка пользователя.
          return tr.docChanged ? tr.setMeta(NORMALIZE, true).setMeta('addToHistory', false) : null;
        },
      }),
    ];
  },
});
function ImageView({ node, extension }: NodeViewProps) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    let objectUrl = '';
    void imageUrl(node.attrs.src, extension.options.userId)
      .then((value) => {
        objectUrl = value;
        if (active) setUrl(value);
        else URL.revokeObjectURL(value);
      })
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [node.attrs.src, extension.options.userId]);
  return (
    <NodeViewWrapper className="note-image" contentEditable={false}>
      {url ? (
        <img src={url} alt={node.attrs.alt || 'Изображение в заметке'} />
      ) : (
        <span>{error || 'Загрузка изображения…'}</span>
      )}
    </NodeViewWrapper>
  );
}
const LocalImage = Image.extend<{
  userId: string;
  inline: boolean;
  allowBase64: boolean;
  HTMLAttributes: Record<string, unknown>;
}>({
  addOptions() {
    return {
      ...this.parent?.(),
      userId: '',
      inline: false,
      allowBase64: false,
      HTMLAttributes: {},
    };
  },
  addNodeView() {
    return ReactNodeViewRenderer(ImageView);
  },
});
export function NoteEditor({ workspace, id }: { workspace: Workspace; id: string }) {
  const meta = workspace.metadata.get(id);
  if (meta?.encrypted) {
    const doc = workspace.secure.doc(id);
    return doc ? (
      <EditorBody key={doc.guid} workspace={workspace} id={id} doc={doc} />
    ) : (
      <UnlockNote workspace={workspace} id={id} />
    );
  }
  return <PlainEditor workspace={workspace} id={id} />;
}
function PlainEditor({ workspace, id }: { workspace: Workspace; id: string }) {
  const entry = workspace.note(id);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let active = true;
    entry.ready.then(() => active && setReady(true));
    return () => {
      active = false;
      void workspace.saveVersion(id);
    };
  }, [entry, workspace, id]);
  return ready ? (
    <EditorBody key={entry.doc.guid} workspace={workspace} id={id} doc={entry.doc} />
  ) : (
    <div className="empty">Открываем заметку…</div>
  );
}
/** Экран заметки под паролем: пароль спрашивается при открытии. */
function UnlockNote({ workspace, id }: { workspace: Workspace; id: string }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="unlock"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        try {
          await workspace.secure.unlock(id, password);
        } catch (err) {
          setError(err instanceof WrongPasswordError ? 'Неверный пароль' : (err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <span className="welcome-icon">
        <Lock size={26} />
      </span>
      <h2>Заметка под паролем</h2>
      <p className="muted">Содержимое зашифровано на этом устройстве. Введите пароль заметки.</p>
      <label>
        Пароль
        <input
          type="password"
          autoFocus
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button className="primary" disabled={busy || !password}>
        {busy ? 'Проверяем…' : 'Открыть'}
      </button>
    </form>
  );
}
function EditorBody({ workspace, id, doc }: { workspace: Workspace; id: string; doc: Y.Doc }) {
  const imageInput = useRef<HTMLInputElement>(null);
  const [link, setLink] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const toast = useUI((s) => s.toast);
  const editable = workspace.canEdit(id);
  const editor = useEditor({
    editable,
    extensions: [
      StarterKit.configure({
        undoRedo: false,
        heading: { levels: [2, 3] },
        link: { openOnClick: false },
      }),
      Collaboration.configure({ document: doc, field: 'content' }),
      Spoiler,
      TaskList,
      Tasks,
      TaskIds,
      LocalImage.configure({ userId: workspace.userId }),
    ],
    editorProps: {
      attributes: { 'aria-label': 'Текст заметки', class: 'note-body' },
      handlePaste: (_view, event) => {
        const files = [...(event.clipboardData?.files || [])];
        if (!files.length) return false;
        event.preventDefault();
        void addFiles(files);
        return true;
      },
      handleDrop: (_view, event) => {
        const files = [...(event.dataTransfer?.files || [])];
        if (!files.length) return false;
        event.preventDefault();
        void addFiles(files);
        return true;
      },
      handleClick: (_view, _pos, event) => {
        const target = (event.target as HTMLElement).closest('[data-spoiler]');
        if (target) {
          target.classList.toggle('revealed');
          return true;
        }
        return false;
      },
      handleKeyDown: (_view, event) => {
        if (
          (event.key === 'Enter' || event.key === ' ') &&
          (event.target as HTMLElement).matches('[data-spoiler]')
        ) {
          event.preventDefault();
          (event.target as HTMLElement).classList.toggle('revealed');
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ transaction }) => {
      // Открытие заметки и правки с других устройств приходят транзакцией y-sync —
      // это не изменение, дату правки не трогаем (иначе заметка всплывает наверх списка).
      if (transaction.getMeta(ySyncPluginKey) || transaction.getMeta(NORMALIZE)) return;
      queueMicrotask(() => workspace.update(id, {}));
    },
    onSelectionUpdate: () => setTick((t) => t + 1),
    onTransaction: () => setTick((t) => t + 1),
  });
  useEffect(() => {
    editor?.setEditable(editable);
  }, [editor, editable]);
  async function addFiles(files: File[]) {
    if (!workspace.canEdit(id)) return;
    for (const file of files) {
      try {
        const src = await storeImage(file, workspace.userId);
        editor?.chain().focus().setImage({ src, alt: file.name }).run();
        void flushImages(workspace);
      } catch (error) {
        toast((error as Error).message);
      }
    }
  }
  if (!editor) return null;
  const hiddenTitle = Boolean(workspace.metadata.get(id)?.hideTitle);
  const button = (label: string, Icon: typeof Bold, action: () => void, active?: boolean) => (
    <button
      key={label}
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={`icon-button ${active ? 'active' : ''}`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={action}
    >
      <Icon size={18} />
    </button>
  );
  return (
    <>
      {editable && (
        <div className="toolbar" data-selection={tick} role="toolbar" aria-label="Форматирование">
          {button(
            'Жирный',
            Bold,
            () => editor.chain().focus().toggleBold().run(),
            editor.isActive('bold'),
          )}
          {button(
            'Курсив',
            Italic,
            () => editor.chain().focus().toggleItalic().run(),
            editor.isActive('italic'),
          )}
          {button(
            'Зачёркнутый',
            Strikethrough,
            () => editor.chain().focus().toggleStrike().run(),
            editor.isActive('strike'),
          )}
          {button(
            'Скрытый текст',
            EyeOff,
            () => editor.chain().focus().toggleMark('spoiler').run(),
            editor.isActive('spoiler'),
          )}
          <span className="toolbar-divider" />
          {button(
            'Заголовок 2',
            Heading2,
            () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
            editor.isActive('heading', { level: 2 }),
          )}
          {button(
            'Заголовок 3',
            Heading3,
            () => editor.chain().focus().toggleHeading({ level: 3 }).run(),
            editor.isActive('heading', { level: 3 }),
          )}
          {button(
            'Маркированный список',
            List,
            () => editor.chain().focus().toggleBulletList().run(),
            editor.isActive('bulletList'),
          )}
          {button(
            'Нумерованный список',
            ListOrdered,
            () => editor.chain().focus().toggleOrderedList().run(),
            editor.isActive('orderedList'),
          )}
          {button(
            'Список задач',
            ListTodo,
            () => editor.chain().focus().toggleTaskList().run(),
            editor.isActive('taskList'),
          )}
          <span className="toolbar-divider" />
          {button(
            'Ссылка',
            Link,
            () => setLink(editor.getAttributes('link').href || ''),
            editor.isActive('link'),
          )}
          {button('Вставить изображение', ImagePlus, () => imageInput.current?.click())}
          <input
            ref={imageInput}
            hidden
            aria-label="Файл изображения"
            type="file"
            accept="image/*"
            multiple
            onChange={(e) => {
              void addFiles([...(e.target.files || [])]);
              e.target.value = '';
            }}
          />
          {button('Отменить', Undo2, () => editor.chain().focus().undo().run())}
          {button('Повторить', Redo2, () => editor.chain().focus().redo().run())}
        </div>
      )}
      <div className="document">
        <input
          className="note-title"
          readOnly={!editable}
          aria-label="Название заметки"
          placeholder="Без названия"
          value={hiddenTitle ? secureTitle(doc) : workspace.metadata.get(id)?.title || ''}
          onChange={(e) => {
            if (hiddenTitle) {
              // заголовок шифруется вместе с содержимым
              doc.getMap('secure').set('title', e.target.value);
              workspace.update(id, {});
            } else workspace.update(id, { title: e.target.value });
          }}
        />
        <EditorContent editor={editor} />
        {editable && <p className="editor-hint">Напишите что-нибудь или начните список с «[ ]»</p>}
      </div>
      {link !== null && (
        <div className="modal-backdrop">
          <form
            className="modal"
            onSubmit={(e) => {
              e.preventDefault();
              if (link && !/^https?:\/\//i.test(link) && !/^mailto:/i.test(link)) {
                toast('Укажите ссылку с https:// или mailto:');
                return;
              }
              if (link)
                editor.chain().focus().extendMarkRange('link').setLink({ href: link }).run();
              else editor.chain().focus().unsetLink().run();
              setLink(null);
            }}
          >
            <h2>Ссылка</h2>
            <label>
              Адрес
              <input
                autoFocus
                value={link}
                onChange={(e) => setLink(e.target.value)}
                placeholder="https://"
              />
            </label>
            <div className="actions">
              <button type="button" onClick={() => setLink(null)}>
                Отмена
              </button>
              <button className="primary">Применить</button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}

/** Изолированный редактор без Collaboration: просмотр никогда не меняет заметку. */
export function VersionPreview({ doc, userId }: { doc: Y.Doc; userId: string }) {
  const editor = useEditor(
    {
      editable: false,
      extensions: [
        StarterKit.configure({ heading: { levels: [2, 3] }, link: { openOnClick: false } }),
        Spoiler,
        TaskList,
        Tasks,
        LocalImage.configure({ userId }),
      ],
      content: yDocToProsemirrorJSON(doc, 'content'),
      editorProps: {
        attributes: { class: 'note-body', 'aria-label': 'Содержимое версии' },
        handleClick: (_view, _pos, event) => {
          const target = (event.target as HTMLElement).closest('[data-spoiler]');
          if (target) {
            target.classList.toggle('revealed');
            return true;
          }
          return false;
        },
      },
    },
    [doc],
  );
  return <EditorContent editor={editor} />;
}

/** Схема документа заметки без интерактивных частей — для импорта и экспорта. */
export function contentExtensions(userId: string) {
  return [
    StarterKit.configure({ heading: { levels: [2, 3] }, link: { openOnClick: false } }),
    Spoiler,
    TaskList,
    Tasks,
    LocalImage.configure({ userId }),
  ];
}

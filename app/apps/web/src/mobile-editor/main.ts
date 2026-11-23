/**
 * Редактор заметки для мобильного приложения: TipTap в WebView.
 * Схема — та же, что у веба (../editorSchema). Свой Y.Doc здесь — копия документа
 * приложения: обновления ходят в обе стороны через мост (протокол — editorBridge в shared).
 * Сеть, хранилище и токены — только на стороне приложения.
 */
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import TaskList from '@tiptap/extension-task-list';
import Image from '@tiptap/extension-image';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import {
  checkTaskAttributes,
  dueDay,
  fromBase64,
  localDate,
  toBase64,
  type EditorActive,
  type EditorCommand,
  type EditorTheme,
  type FromEditor,
  type ToEditor,
} from '@selfnote/shared';
import { Highlight, NORMALIZE, Spoiler, TaskAttributes, TaskIds, TextColor } from '../editorSchema';
import './editor.css';

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage(message: string): void };
    __selfnote?: (message: ToEditor) => void;
  }
}

const FROM_APP = 'app';
const doc = new Y.Doc();
let editor: Editor | null = null;
let editable = true;

function post(message: FromEditor) {
  window.ReactNativeWebView?.postMessage(JSON.stringify(message));
}
window.addEventListener('error', (event) =>
  post({ type: 'error', message: String(event.message) }),
);

// ===== задачи: чекбокс и срок без React =====
const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
function dueInfo(due: string): { text: string; tone: 'today' | 'overdue' | 'later' } {
  const day = dueDay(due);
  const today = localDate();
  const [, m, d] = day.split('-').map(Number);
  const short = `${d} ${MONTHS[m - 1]}`;
  if (day === today) return { text: 'Сегодня', tone: 'today' };
  if (day < today) return { text: `Просрочено · ${short}`, tone: 'overdue' };
  if (day === localDate(new Date(Date.now() + 86400000))) return { text: 'Завтра', tone: 'later' };
  return { text: short, tone: 'later' };
}
const CALENDAR =
  '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>';

const MobileTasks = TaskAttributes.extend({
  addNodeView() {
    return ({ node, getPos, editor: ed }) => {
      let current = node;
      const li = document.createElement('li');
      li.dataset.type = 'taskItem';
      li.className = 'task-item';
      const check = document.createElement('label');
      check.className = 'task-check';
      check.contentEditable = 'false';
      const box = document.createElement('input');
      box.type = 'checkbox';
      check.append(box);
      const content = document.createElement('div');
      content.className = 'task-content';
      const due = document.createElement('label');
      due.className = 'task-due';
      due.contentEditable = 'false';
      const label = document.createElement('span');
      const picker = document.createElement('input');
      picker.type = 'date';
      picker.setAttribute('aria-label', 'Срок задачи');
      due.append(label, picker);
      li.append(check, content, due);

      const patch = (attrs: Record<string, unknown>) => {
        const pos = typeof getPos === 'function' ? getPos() : undefined;
        if (typeof pos !== 'number' || !ed.isEditable) return;
        ed.view.dispatch(
          ed.view.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, ...attrs }),
        );
      };
      box.addEventListener('change', () =>
        patch(checkTaskAttributes(current.attrs, box.checked, localDate())),
      );
      picker.addEventListener('change', () => patch({ due: picker.value || null }));

      const render = () => {
        const checked = Boolean(current.attrs.checked);
        const value = typeof current.attrs.due === 'string' ? current.attrs.due : '';
        li.classList.toggle('checked', checked);
        box.checked = checked;
        box.disabled = picker.disabled = !ed.isEditable;
        box.setAttribute('aria-label', `Выполнить: ${current.textContent || 'задача'}`);
        picker.value = value.slice(0, 10);
        if (value && !checked) {
          const info = dueInfo(value);
          label.textContent = info.text + (current.attrs.repeat ? ' ↻' : '');
          due.className = `task-due ${info.tone}`;
        } else {
          label.innerHTML = value ? '' : CALENDAR;
          due.className = `task-due ${value ? 'hidden' : 'empty'}`;
        }
      };
      render();
      return {
        dom: li,
        contentDOM: content,
        update(next) {
          if (next.type !== current.type) return false;
          current = next;
          render();
          return true;
        },
        stopEvent: (event) =>
          check.contains(event.target as Node) || due.contains(event.target as Node),
        ignoreMutation: (mutation) =>
          mutation.type !== 'selection' && !content.contains(mutation.target),
      };
    };
  },
});

// ===== картинки: данные приносит приложение (у него токен и кэш) =====
const images = new Map<string, string>();
const waiting = new Map<string, Set<(data: string | null, error?: string) => void>>();
function requestImage(src: string, done: (data: string | null, error?: string) => void) {
  const known = images.get(src);
  if (known) return done(known);
  let set = waiting.get(src);
  if (!set) {
    waiting.set(src, (set = new Set()));
    post({ type: 'image', src });
  }
  set.add(done);
}
const MobileImage = Image.extend({
  addNodeView() {
    return ({ node }) => {
      let current = node;
      const wrap = document.createElement('div');
      wrap.className = 'note-image';
      wrap.contentEditable = 'false';
      const note = document.createElement('span');
      note.textContent = 'Загрузка изображения…';
      wrap.append(note);
      let shown = '';
      // Картинку с телефона приложение отдаёт с диска сразу; при смене src (local-image → адрес
      // на сервере после загрузки) старая картинка остаётся на месте, пока не готова новая.
      const show = (src: string) => {
        requestImage(src, (data, error) => {
          if (String(current.attrs.src ?? '') !== src) return;
          if (!data) {
            if (!shown) note.textContent = error || 'Изображение недоступно';
            return;
          }
          if (data === shown) return;
          const img = document.createElement('img');
          img.src = data;
          img.alt = String(current.attrs.alt || 'Изображение в заметке');
          wrap.replaceChildren(img);
          shown = data;
        });
      };
      show(String(node.attrs.src ?? ''));
      return {
        dom: wrap,
        update(next) {
          if (next.type !== current.type) return false;
          const changed = next.attrs.src !== current.attrs.src;
          current = next;
          if (changed) show(String(next.attrs.src ?? ''));
          return true;
        },
      };
    };
  },
});

// ===== заголовок =====
const title = document.getElementById('title') as HTMLTextAreaElement;
function fitTitle() {
  title.style.height = 'auto';
  title.style.height = `${title.scrollHeight}px`;
}
title.addEventListener('input', () => {
  if (title.value.includes('\n')) title.value = title.value.replace(/\n/g, ' ');
  fitTitle();
  post({ type: 'title', title: title.value });
});
title.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  editor?.commands.focus('start');
});
title.addEventListener('focus', () => post({ type: 'focus', focused: true, area: 'title' }));
title.addEventListener('blur', () => {
  setTimeout(() => {
    if (!editor?.isFocused) post({ type: 'focus', focused: false, area: null });
  }, 0);
});

// ===== состояние панели =====
let lastActive = '';
function reportActive() {
  if (!editor) return;
  const e = editor;
  const active: EditorActive = {
    bold: e.isActive('bold'),
    italic: e.isActive('italic'),
    strike: e.isActive('strike'),
    spoiler: e.isActive('spoiler'),
    heading2: e.isActive('heading', { level: 2 }),
    heading3: e.isActive('heading', { level: 3 }),
    bulletList: e.isActive('bulletList'),
    orderedList: e.isActive('orderedList'),
    taskList: e.isActive('taskList'),
    link: e.isActive('link'),
    undo: e.can().undo(),
    redo: e.can().redo(),
  };
  const link = e.isActive('link') ? String(e.getAttributes('link').href ?? '') : null;
  const key = JSON.stringify([active, link]);
  if (key === lastActive) return;
  lastActive = key;
  post({ type: 'active', active, link });
}

function run(command: EditorCommand) {
  if (!editor) return;
  const chain = editor.chain().focus();
  switch (command) {
    case 'bold':
      return chain.toggleBold().run();
    case 'italic':
      return chain.toggleItalic().run();
    case 'strike':
      return chain.toggleStrike().run();
    case 'spoiler':
      return chain.toggleMark('spoiler').run();
    case 'heading2':
      return chain.toggleHeading({ level: 2 }).run();
    case 'heading3':
      return chain.toggleHeading({ level: 3 }).run();
    case 'bulletList':
      return chain.toggleBulletList().run();
    case 'orderedList':
      return chain.toggleOrderedList().run();
    case 'taskList':
      return chain.toggleTaskList().run();
    case 'undo':
      return chain.undo().run();
    case 'redo':
      return chain.redo().run();
    case 'focusEnd':
      return editor.commands.focus('end');
    case 'blur':
      title.blur();
      return editor.commands.blur();
  }
}

function applyTheme(theme: EditorTheme) {
  const root = document.documentElement;
  root.dataset.theme = theme.dark ? 'dark' : 'light';
  for (const [name, value] of Object.entries(theme.colors))
    root.style.setProperty(`--${name}`, value);
}

let changedTimer: ReturnType<typeof setTimeout> | undefined;
function create(isEditable: boolean) {
  editor = new Editor({
    element: document.getElementById('editor')!,
    editable: isEditable,
    extensions: [
      StarterKit.configure({
        undoRedo: false,
        heading: { levels: [2, 3] },
        link: { openOnClick: false },
      }),
      Collaboration.configure({ document: doc, field: 'content' }),
      Spoiler,
      TextColor,
      Highlight,
      TaskList,
      MobileTasks,
      TaskIds,
      MobileImage,
    ],
    editorProps: {
      attributes: { 'aria-label': 'Текст заметки', class: 'note-body' },
      // над клавиатурой висит панель приложения (~50 px) — строка с курсором не должна под ней прятаться
      scrollThreshold: { top: 40, bottom: 90, left: 0, right: 0 },
      scrollMargin: { top: 40, bottom: 90, left: 0, right: 0 },
      handleClick: (_view, _pos, event) => {
        const target = event.target as HTMLElement;
        const spoiler = target.closest('[data-spoiler]');
        if (spoiler) {
          spoiler.classList.toggle('revealed');
          return !editable;
        }
        const link = target.closest('a[href]');
        if (link && !editable) {
          post({ type: 'openLink', href: link.getAttribute('href')! });
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ transaction }) => {
      if (transaction.getMeta(ySyncPluginKey) || transaction.getMeta(NORMALIZE)) return;
      if (changedTimer) return;
      changedTimer = setTimeout(() => {
        changedTimer = undefined;
        post({ type: 'changed' });
      }, 800);
    },
    onTransaction: reportActive,
    onSelectionUpdate: reportActive,
    onFocus: () => {
      post({ type: 'focus', focused: true, area: 'body' });
      reportActive();
    },
    onBlur: () =>
      setTimeout(() => {
        if (document.activeElement !== title) post({ type: 'focus', focused: false, area: null });
      }, 0),
  });
}

doc.on('update', (update: Uint8Array, origin: unknown) => {
  if (origin !== FROM_APP) post({ type: 'update', update: toBase64(update) });
});

window.__selfnote = (message: ToEditor) => {
  switch (message.type) {
    case 'init':
      applyTheme(message.theme);
      Y.applyUpdate(doc, fromBase64(message.state), FROM_APP);
      editable = message.editable;
      title.value = message.title;
      title.placeholder = message.titlePlaceholder;
      title.readOnly = !editable;
      fitTitle();
      if (!editor) create(editable);
      if (message.focusTitle && editable) title.focus();
      break;
    case 'update':
      Y.applyUpdate(doc, fromBase64(message.update), FROM_APP);
      break;
    case 'title':
      if (document.activeElement !== title && title.value !== message.title) {
        title.value = message.title;
        fitTitle();
      }
      break;
    case 'editable':
      editable = message.editable;
      title.readOnly = !editable;
      editor?.setEditable(editable, false);
      break;
    case 'theme':
      applyTheme(message.theme);
      break;
    case 'command':
      run(message.command);
      break;
    case 'link':
      if (!editor) break;
      if (message.href)
        editor.chain().focus().extendMarkRange('link').setLink({ href: message.href }).run();
      else editor.chain().focus().extendMarkRange('link').unsetLink().run();
      break;
    case 'insertImage':
      editor?.chain().focus().setImage({ src: message.src }).createParagraphNear().run();
      break;
    case 'image': {
      if (message.data) images.set(message.src, message.data);
      const set = waiting.get(message.src);
      waiting.delete(message.src);
      for (const done of set ?? []) done(message.data, message.error);
      break;
    }
  }
};
post({ type: 'ready' });

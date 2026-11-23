/**
 * Схема документа заметки, общая для веб-редактора и редактора мобильного
 * приложения (src/mobile-editor): метки, атрибуты задач, выдача id задачам.
 * Расходиться схемам нельзя — y-prosemirror молча выбрасывает незнакомые узлы и метки.
 */
import { Extension, Mark, mergeAttributes } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import TaskItem from '@tiptap/extension-task-item';
import { NOTE_COLORS, type NoteColor } from '@selfnote/shared';
import { uuid } from './ids';

export const Spoiler = Mark.create({
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
export const isNoteColor = (value: unknown): value is NoteColor =>
  typeof value === 'string' && (NOTE_COLORS as readonly string[]).includes(value);
/**
 * Цвет текста и подложка. Храним не hex, а имя цвета из палитры: так цвет
 * подстраивается под тёмную тему и одинаково выглядит на публичной странице.
 */
export const TextColor = Mark.create({
  name: 'textColor',
  addAttributes: () => ({
    color: {
      default: null,
      parseHTML: (el) => el.getAttribute('data-text-color'),
      renderHTML: () => ({}),
    },
  }),
  parseHTML: () => [
    {
      tag: 'span[data-text-color]',
      getAttrs: (el) => (isNoteColor(el.getAttribute('data-text-color')) ? null : false),
    },
  ],
  renderHTML: ({ mark }) => [
    'span',
    { 'data-text-color': mark.attrs.color, class: `text-color-${mark.attrs.color}` },
    0,
  ],
});
export const Highlight = Mark.create({
  name: 'highlight',
  addAttributes: () => ({
    color: {
      default: 'yellow',
      parseHTML: (el) => el.getAttribute('data-highlight') || 'yellow',
      renderHTML: () => ({}),
    },
  }),
  parseHTML: () => [{ tag: 'mark' }],
  renderHTML: ({ mark }) => [
    'mark',
    { 'data-highlight': mark.attrs.color, class: `highlight-${mark.attrs.color}` },
    0,
  ],
});
/** Задача: срок, отметка о выполнении и повтор хранятся в атрибутах узла. */
export const TaskAttributes = TaskItem.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      id: { default: null, keepOnSplit: false },
      due: { default: null, keepOnSplit: false },
      doneAt: { default: null, keepOnSplit: false },
      repeat: { default: null, keepOnSplit: false },
    };
  },
});
export const NORMALIZE = 'selfnote-normalize';
export const TaskIds = Extension.create({
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

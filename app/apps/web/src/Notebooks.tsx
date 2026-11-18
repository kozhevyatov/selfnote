import { useState } from 'react';
import {
  ChevronDown,
  ChevronUp,
  GripVertical,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';
import type { Notebook, Section } from '@selfnote/shared';
import { NotebookIcon } from './NotebookIcon';
import type { Workspace } from './store';

/** Действия с книжками живут в App (там общий диалог) — сюда приходят готовыми. */
export interface NotebookActions {
  addNotebook: () => void;
  editNotebook: (book: Notebook) => void;
  removeNotebook: (book: Notebook) => void;
  addSection: (notebookId: string) => void;
  editSection: (section: Section) => void;
  removeSection: (section: Section) => void;
}

const ORDER_TYPE = 'application/x-selfnote-order';

/** Новый порядок: id переезжает на позицию index среди остальных. */
function moved(ids: string[], id: string, index: number) {
  const rest = ids.filter((x) => x !== id);
  rest.splice(Math.max(0, Math.min(index, rest.length)), 0, id);
  return rest;
}

const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10,
    m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return `${n} ${one}`;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return `${n} ${few}`;
  return `${n} ${many}`;
};

/** Настройки → Записные книжки: порядок книжек и подразделов, правка, удаление. */
export function NotebooksSettings({
  workspace,
  actions,
}: {
  workspace: Workspace;
  actions: NotebookActions;
}) {
  const notebooks = workspace.orderedNotebooks();
  const sections = workspace.orderedSections();
  const notes = [...workspace.metadata.values()].filter((n) => !n.deletedAt);
  /** Что тащим: книжку или подраздел (внутри своей книжки). */
  const [dragging, setDragging] = useState<{ id: string; group: string } | null>(null);
  const [over, setOver] = useState<string | null>(null);

  const reorder = (ids: string[], id: string, index: number) =>
    workspace.setOrder(moved(ids, id, index));

  /** Перетаскивание мышью (на телефоне — кнопки вверх/вниз). */
  const dragProps = (group: string, ids: string[], id: string) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      e.stopPropagation();
      e.dataTransfer.setData(ORDER_TYPE, id);
      e.dataTransfer.effectAllowed = 'move';
      setDragging({ id, group });
    },
    onDragEnd: () => {
      setDragging(null);
      setOver(null);
    },
    onDragOver: (e: React.DragEvent) => {
      if (!dragging || dragging.group !== group || !e.dataTransfer.types.includes(ORDER_TYPE))
        return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      setOver(id);
    },
    onDrop: (e: React.DragEvent) => {
      if (!dragging || dragging.group !== group) return;
      e.preventDefault();
      e.stopPropagation();
      const from = dragging.id;
      setDragging(null);
      setOver(null);
      if (from === id) return;
      // тащим вниз — встаём после цели, вверх — перед ней
      const rest = ids.filter((x) => x !== from);
      const index = ids.indexOf(from) < ids.indexOf(id) ? rest.indexOf(id) + 1 : rest.indexOf(id);
      reorder(ids, from, index);
    },
  });

  const arrows = (ids: string[], id: string, label: string) => {
    const index = ids.indexOf(id);
    return (
      <>
        <button
          type="button"
          className="icon-button"
          aria-label={`Поднять «${label}»`}
          title="Выше"
          disabled={index === 0}
          onClick={() => reorder(ids, id, index - 1)}
        >
          <ChevronUp size={16} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={`Опустить «${label}»`}
          title="Ниже"
          disabled={index === ids.length - 1}
          onClick={() => reorder(ids, id, index + 1)}
        >
          <ChevronDown size={16} />
        </button>
      </>
    );
  };

  const bookIds = notebooks.map((b) => b.id);
  return (
    <>
      <p className="muted settings-lead">
        Порядок здесь — тот же, что в боковой панели, и переходит на другие ваши устройства.
        Перетаскивайте за ручку или двигайте стрелками.
      </p>
      <section className="settings-card">
        <h2>
          Записные книжки {notebooks.length > 0 && <small>{notebooks.length}</small>}
        </h2>
        {!notebooks.length && <p className="muted">Книжек пока нет.</p>}
        <ul className="order-list">
          {notebooks.map((book) => {
            const own = sections.filter((s) => s.notebookId === book.id);
            const ownIds = own.map((s) => s.id);
            const count = notes.filter((n) => n.notebookId === book.id).length;
            return (
              <li
                key={book.id}
                className={`order-item ${over === book.id && dragging?.group === 'books' ? 'drop-target' : ''} ${dragging?.id === book.id ? 'dragging' : ''}`}
                {...dragProps('books', bookIds, book.id)}
              >
                <div className="order-row">
                  <span className="order-grip" aria-hidden="true">
                    <GripVertical size={16} />
                  </span>
                  <span
                    className="book-icon"
                    style={{ color: book.color, background: `${book.color}12` }}
                  >
                    <NotebookIcon name={book.icon} />
                  </span>
                  <div className="order-text">
                    <strong>{book.name}</strong>
                    <small>
                      {plural(count, 'заметка', 'заметки', 'заметок')}
                      {own.length > 0 && ` · ${plural(own.length, 'подраздел', 'подраздела', 'подразделов')}`}
                    </small>
                  </div>
                  {arrows(bookIds, book.id, book.name)}
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Настройки книжки «${book.name}»`}
                    title="Название, цвет, значок"
                    onClick={() => actions.editNotebook(book)}
                  >
                    <Pencil size={16} />
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Добавить подраздел в «${book.name}»`}
                    title="Добавить подраздел"
                    onClick={() => actions.addSection(book.id)}
                  >
                    <Plus size={16} />
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Удалить книжку «${book.name}»`}
                    title="Удалить"
                    onClick={() => actions.removeNotebook(book)}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
                {own.length > 0 && (
                  <ul className="order-list order-sublist">
                    {own.map((section) => (
                      <li
                        key={section.id}
                        className={`order-item ${over === section.id && dragging?.group === book.id ? 'drop-target' : ''} ${dragging?.id === section.id ? 'dragging' : ''}`}
                        {...dragProps(book.id, ownIds, section.id)}
                      >
                        <div className="order-row">
                          <span className="order-grip" aria-hidden="true">
                            <GripVertical size={15} />
                          </span>
                          <div className="order-text">
                            <strong>{section.name}</strong>
                            <small>
                              {plural(
                                notes.filter((n) => n.sectionId === section.id).length,
                                'заметка',
                                'заметки',
                                'заметок',
                              )}
                            </small>
                          </div>
                          {arrows(ownIds, section.id, section.name)}
                          <button
                            type="button"
                            className="icon-button"
                            aria-label={`Переименовать «${section.name}»`}
                            title="Переименовать"
                            onClick={() => actions.editSection(section)}
                          >
                            <Pencil size={15} />
                          </button>
                          <button
                            type="button"
                            className="icon-button"
                            aria-label={`Удалить подраздел «${section.name}»`}
                            title="Удалить"
                            onClick={() => actions.removeSection(section)}
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
        <button type="button" className="soft-button order-add" onClick={actions.addNotebook}>
          <Plus size={16} /> Новая записная книжка
        </button>
      </section>
    </>
  );
}

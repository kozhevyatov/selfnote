import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import {
  extractDocument,
  setTaskChecked,
  deletedNoteIds,
  uniqueTasks,
  versionsToKeep,
} from './index.js';
function fixture() {
  const doc = new Y.Doc();
  const item = new Y.XmlElement('taskItem');
  item.setAttribute('id', 'task-1');
  item.setAttribute('checked', false as unknown as string);
  item.setAttribute('due', '2026-11-15');
  const p = new Y.XmlElement('paragraph');
  const t = new Y.XmlText();
  t.insert(0, 'Купить молоко', { bold: {} });
  p.insert(0, [t]);
  item.insert(0, [p]);
  const list = new Y.XmlElement('taskList');
  list.insert(0, [item]);
  doc.getXmlFragment('content').insert(0, [list]);
  return doc;
}
describe('Документ заметки', () => {
  it('извлекает текст без XML и задачи с атрибутами', () => {
    expect(extractDocument(fixture())).toEqual({
      plainText: 'Купить молоко',
      tasks: [
        {
          id: 'task-1',
          text: 'Купить молоко',
          checked: false,
          due: '2026-11-15',
          doneAt: null,
          position: 0,
          repeat: null,
        },
      ],
    });
  });
  it('меняет исходный пункт и синхронизирует его во вторую копию', () => {
    const a = fixture(),
      b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const vector = Y.encodeStateVector(b);
    expect(setTaskChecked(a, 'task-1', true)).toBe(true);
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a, vector));
    expect(extractDocument(b).tasks[0].checked).toBe(true);
    expect(extractDocument(b).tasks[0].doneAt).toBeTruthy();
  });
  it('объединяет независимые офлайн-правки', () => {
    const a = fixture(),
      b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    setTaskChecked(a, 'task-1', true);
    const p = new Y.XmlElement('paragraph');
    const t = new Y.XmlText();
    t.insert(0, 'Новая строка');
    p.insert(0, [t]);
    b.getXmlFragment('content').push([p]);
    const updateA = Y.encodeStateAsUpdate(a),
      updateB = Y.encodeStateAsUpdate(b);
    Y.applyUpdate(a, updateB);
    Y.applyUpdate(b, updateA);
    expect(extractDocument(a)).toEqual(extractDocument(b));
    expect(extractDocument(a).plainText).toContain('Новая строка');
    expect(extractDocument(a).tasks[0].checked).toBe(true);
  });
  it('возвращает пустой результат для пустого документа', () =>
    expect(extractDocument(new Y.Doc())).toEqual({ plainText: '', tasks: [] }));
});
describe('Вспомогательные функции сервера', () => {
  it('находит заметки в корзине в старом и новом формате', () => {
    const doc = new Y.Doc();
    const notes = doc.getMap<unknown>('notes');
    notes.set('old', { id: 'old', deletedAt: '2026-11-01T00:00:00Z' });
    notes.set('alive', { id: 'alive', deletedAt: null });
    const fresh = new Y.Map<unknown>();
    fresh.set('deletedAt', '2026-11-02T00:00:00Z');
    notes.set('new', fresh);
    expect([...deletedNoteIds(doc)].sort()).toEqual(['new', 'old']);
  });
  it('убирает повторы задач', () => {
    const t = { text: '', checked: false, due: null, doneAt: null, position: 0 };
    expect(
      uniqueTasks([
        { ...t, id: 'a' },
        { ...t, id: 'a' },
        { ...t, id: 'b' },
      ]).map((x) => x.id),
    ).toEqual(['a', 'b']);
  });
  it('прореживает версии', () => {
    const now = Date.parse('2026-11-15T12:00:00Z');
    const iso = (h: number) => new Date(now - h * 3600000).toISOString();
    const versions = [
      { id: 'fresh1', created_at: iso(1) },
      { id: 'fresh2', created_at: iso(2) },
      { id: 'day2-late', created_at: iso(30) },
      { id: 'day2-early', created_at: iso(33) },
      { id: 'old-a', created_at: iso(24 * 60) },
      { id: 'old-b', created_at: iso(24 * 60 + 2) },
    ];
    const keep = versionsToKeep(versions, now);
    expect(keep.has('fresh1') && keep.has('fresh2') && keep.has('day2-late')).toBe(true);
    expect(keep.has('day2-early')).toBe(false);
    expect(keep.has('old-a') !== keep.has('old-b')).toBe(true);
  });
});

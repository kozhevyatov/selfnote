import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { expiredNoteIds, restoreContent, extractDocument } from './index';
describe('История и корзина', () => {
  it('восстанавливает удалённые узлы и передаёт восстановление другой реплике', () => {
    const doc = new Y.Doc(),
      peer = new Y.Doc();
    const p = new Y.XmlElement('paragraph'),
      text = new Y.XmlText();
    text.insert(0, 'Старая версия');
    text.format(0, 6, { bold: {} });
    p.insert(0, [text]);
    doc.getXmlFragment('content').insert(0, [p]);
    const saved = Y.encodeStateAsUpdate(doc);
    doc.getXmlFragment('content').delete(0, 1);
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    const vector = Y.encodeStateVector(peer);
    restoreContent(doc, saved);
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc, vector));
    expect(extractDocument(peer).plainText).toBe('Старая версия');
    expect(peer.getXmlFragment('content').toString()).toContain('<bold>');
    doc.destroy();
    peer.destroy();
  });
  it('очищает только удалённые более 30 дней назад в обоих форматах', () => {
    const space = new Y.Doc();
    const now = Date.parse('2026-11-16T00:00:00Z');
    const old = new Date(now - 31 * 86400000).toISOString();
    space.getMap('notes').set('legacy', { deletedAt: old, updatedAt: new Date(now).toISOString() });
    space.getMap('notes').set('fields', new Y.Map([['deletedAt', old]]));
    space.getMap('notes').set('edge', { deletedAt: new Date(now - 30 * 86400000).toISOString() });
    space.getMap('notes').set('invalid', { deletedAt: 'ошибка' });
    space.getMap('notes').set('active', { deletedAt: null });
    expect(expiredNoteIds(space, now).sort()).toEqual(['fields', 'legacy']);
    space.destroy();
  });
});

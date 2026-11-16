import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import {
  checkTaskAttributes,
  extractDocument,
  firstDue,
  formatRepeat,
  newKdf,
  nextDue,
  parseRepeat,
  renderDocument,
  repeatLabel,
  seal,
  deriveKey,
  setTaskChecked,
  shareKeyNeedsPassword,
  snippet,
  unseal,
  unwrapShareKey,
  wrapShareKey,
  WrongPasswordError,
} from './index.js';

describe('Повторяющиеся задачи', () => {
  const mondays = 'FREQ=WEEKLY;BYDAY=MO';
  it('разбирает и подписывает правила', () => {
    expect(parseRepeat('FREQ=WEEKLY;BYDAY=WE,MO')).toEqual({ freq: 'WEEKLY', days: [0, 2] });
    expect(formatRepeat({ freq: 'WEEKLY', days: [0, 2] })).toBe('FREQ=WEEKLY;BYDAY=MO,WE');
    expect(repeatLabel(mondays)).toBe('По понедельникам');
    expect(repeatLabel('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR')).toBe('По будням');
    expect(repeatLabel('FREQ=DAILY')).toBe('Каждый день');
    expect(repeatLabel('')).toBe('');
  });
  it('«по понедельникам» после отметки переезжает на следующий понедельник', () => {
    // 2026-11-16 — понедельник
    expect(nextDue('2026-11-16', mondays, '2026-11-16')).toBe('2026-11-23');
    // просрочена с прошлого понедельника, отмечена в среду
    expect(nextDue('2026-11-09', mondays, '2026-11-18')).toBe('2026-11-23');
  });
  it('ежедневно, по будням и ежемесячно', () => {
    expect(nextDue('2026-11-16', 'FREQ=DAILY', '2026-11-16')).toBe('2026-11-17');
    // пятница → понедельник
    expect(nextDue('2026-11-20', 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', '2026-11-20')).toBe(
      '2026-11-23',
    );
    // 31-е в месяце без 31-го дня → последний день месяца
    expect(nextDue('2026-01-31', 'FREQ=MONTHLY', '2026-01-31')).toBe('2026-02-28');
    expect(firstDue('FREQ=WEEKLY;BYDAY=SU', '2026-11-16')).toBe('2026-11-22');
  });
  it('отметка повторяющейся задачи снимает галочку и сдвигает срок', () => {
    expect(
      checkTaskAttributes({ due: '2026-11-16', repeat: mondays }, true, '2026-11-16', 'T'),
    ).toEqual({ checked: false, doneAt: 'T', due: '2026-11-23' });
    expect(checkTaskAttributes({ due: '2026-11-16' }, true, '2026-11-16', 'T')).toEqual({
      checked: true,
      doneAt: 'T',
    });
  });
  it('setTaskChecked учитывает повтор', () => {
    const doc = new Y.Doc();
    const item = new Y.XmlElement('taskItem');
    item.setAttribute('id', 't');
    item.setAttribute('due', '2020-01-06');
    item.setAttribute('repeat', mondays);
    const list = new Y.XmlElement('taskList');
    list.insert(0, [item]);
    doc.getXmlFragment('content').insert(0, [list]);
    setTaskChecked(doc, 't', true);
    const task = extractDocument(doc).tasks[0];
    expect(task.checked).toBe(false);
    expect(task.repeat).toBe(mondays);
    expect(new Date(`${task.due}T12:00:00Z`).getUTCDay()).toBe(1);
    expect(task.due! > '2020-01-06').toBe(true);
    expect(task.doneAt).toBeTruthy();
  });
});

describe('Подсветка совпадений', () => {
  it('находит слово по началу и выделяет его', () => {
    const parts = snippet('Купить молоко и хлеб в магазине', 'мол')!;
    expect(parts.filter((p) => p.mark).map((p) => p.text)).toEqual(['мол']);
    expect(snippet('Купить молоко', 'око')).toBeNull();
  });
});

describe('HTML публичной страницы', () => {
  it('экранирует текст, фильтрует ссылки и подставляет картинки', () => {
    const doc = new Y.Doc();
    const p = new Y.XmlElement('paragraph');
    const t = new Y.XmlText();
    t.insert(0, '<script>', { bold: {} });
    t.insert(8, 'плохо', { link: { href: 'javascript:alert(1)' } });
    t.insert(13, 'хорошо', { link: { href: 'https://example.com' } });
    p.insert(0, [t]);
    const image = new Y.XmlElement('image');
    image.setAttribute('src', '/api/attachments/abc');
    doc.getXmlFragment('content').insert(0, [p, image]);
    const result = renderDocument(doc.getXmlFragment('content'), {
      image: (src) => `/s/token/img/${src.split('/').pop()}`,
    });
    expect(result.html).toContain('<strong>&lt;script&gt;</strong>');
    expect(result.html).not.toContain('javascript:');
    expect(result.html).toContain('href="https://example.com"');
    expect(result.html).toContain('src="/s/token/img/abc"');
    expect(result.images).toEqual(['/api/attachments/abc']);
    expect(result.text).toBe('<script>плохохорошо');
  });
});

describe('Шифрование', () => {
  const fast = () => newKdf(1000);
  it('шифрует и расшифровывает, неверный пароль — понятная ошибка', async () => {
    const kdf = fast();
    const key = await deriveKey('пароль', kdf);
    const envelope = await seal(key, kdf, new TextEncoder().encode('секрет'));
    expect(envelope.data).not.toContain('секрет');
    expect(new TextDecoder().decode(await unseal(await deriveKey('пароль', kdf), envelope))).toBe(
      'секрет',
    );
    await expect(unseal(await deriveKey('другой', kdf), envelope)).rejects.toBeInstanceOf(
      WrongPasswordError,
    );
  });
  it('ключ во фрагменте ссылки — открытый и под паролем ссылки', async () => {
    const key = await deriveKey('пароль', fast());
    const open = await wrapShareKey(key);
    expect(shareKeyNeedsPassword(open)).toBe(false);
    expect(await unwrapShareKey(open)).toEqual(key);
    const locked = await wrapShareKey(key, 'ссылка');
    expect(shareKeyNeedsPassword(locked)).toBe(true);
    expect(await unwrapShareKey(locked, 'ссылка')).toEqual(key);
    await expect(unwrapShareKey(locked, 'нет')).rejects.toBeInstanceOf(WrongPasswordError);
  }, 20000);
});

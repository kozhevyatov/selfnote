/**
 * Повторяющиеся задачи. Правило хранится в атрибуте `repeat` пункта списка задач
 * в виде подмножества RRULE: FREQ=DAILY | FREQ=WEEKLY;BYDAY=MO,WE | FREQ=MONTHLY.
 */
export const WEEK_DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
export const WEEK_DAY_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const WEEK_DAY_PLURAL = [
  'понедельникам',
  'вторникам',
  'средам',
  'четвергам',
  'пятницам',
  'субботам',
  'воскресеньям',
];
export interface Repeat {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY';
  /** Дни недели для WEEKLY: 0 — понедельник … 6 — воскресенье. */
  days: number[];
}
export function parseRepeat(rule: unknown): Repeat | null {
  if (typeof rule !== 'string' || !rule) return null;
  const parts = new Map(
    rule
      .toUpperCase()
      .split(';')
      .map((p) => p.split('=') as [string, string]),
  );
  const freq = parts.get('FREQ');
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY') return null;
  const days = (parts.get('BYDAY') ?? '')
    .split(',')
    .map((d) => WEEK_DAYS.indexOf(d as (typeof WEEK_DAYS)[number]))
    .filter((d) => d >= 0)
    .sort((a, b) => a - b);
  return { freq, days: [...new Set(days)] };
}
export function formatRepeat(repeat: Repeat): string {
  if (repeat.freq === 'WEEKLY' && repeat.days.length)
    return `FREQ=WEEKLY;BYDAY=${repeat.days.map((d) => WEEK_DAYS[d]).join(',')}`;
  return `FREQ=${repeat.freq}`;
}
export function repeatLabel(rule: unknown): string {
  const repeat = parseRepeat(rule);
  if (!repeat) return '';
  if (repeat.freq === 'DAILY') return 'Каждый день';
  if (repeat.freq === 'MONTHLY') return 'Каждый месяц';
  const days = repeat.days;
  if (!days.length) return 'Каждую неделю';
  if (days.length === 7) return 'Каждый день';
  if (days.join() === '0,1,2,3,4') return 'По будням';
  if (days.join() === '5,6') return 'По выходным';
  if (days.length === 1) return `По ${WEEK_DAY_PLURAL[days[0]]}`;
  return days.map((d) => WEEK_DAY_SHORT[d]).join(', ');
}
// Даты — строки YYYY-MM-DD; считаем в UTC, чтобы переход на летнее время не сдвигал дни.
function toDate(day: string) {
  const [y, m, d] = day.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function toDay(date: Date) {
  return date.toISOString().slice(0, 10);
}
function addDays(day: string, days: number) {
  const date = toDate(day);
  date.setUTCDate(date.getUTCDate() + days);
  return toDay(date);
}
/** 0 — понедельник. */
function weekDay(day: string) {
  return (toDate(day).getUTCDay() + 6) % 7;
}
function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}
function matches(repeat: Repeat, day: string, anchor: string) {
  if (repeat.freq === 'DAILY') return true;
  if (repeat.freq === 'WEEKLY')
    return (repeat.days.length ? repeat.days : [weekDay(anchor)]).includes(weekDay(day));
  const date = toDate(day);
  const wanted = Math.min(
    toDate(anchor).getUTCDate(),
    daysInMonth(date.getUTCFullYear(), date.getUTCMonth()),
  );
  return date.getUTCDate() === wanted;
}
/** Первая подходящая дата не раньше `from` (включительно). */
export function firstDue(rule: unknown, from: string, anchor = from): string | null {
  const repeat = parseRepeat(rule);
  if (!repeat) return null;
  let day = from.slice(0, 10);
  for (let i = 0; i < 400; i++, day = addDays(day, 1)) if (matches(repeat, day, anchor)) return day;
  return null;
}
/**
 * Следующий срок после отметки: строго позже и прежнего срока, и сегодняшнего дня.
 * Просроченная «по понедельникам» задача, отмеченная в среду, уезжает на ближайший понедельник.
 */
export function nextDue(due: string | null, rule: unknown, today: string): string | null {
  const anchor = (due || today).slice(0, 10);
  const from = anchor > today ? anchor : today;
  return firstDue(rule, addDays(from, 1), anchor);
}
/**
 * Изменения атрибутов пункта при отметке. У повторяющейся задачи галочка не ставится:
 * срок переезжает на следующий повтор, а время выполнения сохраняется в doneAt.
 */
export function checkTaskAttributes(
  attrs: { due?: unknown; repeat?: unknown },
  checked: boolean,
  today: string,
  now = new Date().toISOString(),
): { checked: boolean; doneAt: string | null; due?: string } {
  if (checked && parseRepeat(attrs.repeat)) {
    const due = typeof attrs.due === 'string' && attrs.due ? attrs.due : null;
    const next = nextDue(due, attrs.repeat, today);
    if (next) return { checked: false, doneAt: now, due: next };
  }
  return { checked, doneAt: checked ? now : null };
}

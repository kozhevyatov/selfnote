import { dueDay, localDate } from '@selfnote/shared';

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const MONTH_NAMES = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const WEEKDAYS = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
const WEEKDAYS_SHORT = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const pad = (n: number) => String(n).padStart(2, '0');

/** «Понедельник, 23 ноября» — над заголовком главного экрана. */
export function todayLabel(now = new Date()) {
  return `${WEEKDAYS[now.getDay()]}, ${now.getDate()} ${MONTHS[now.getMonth()]}`;
}
export function dayMonth(d: Date) {
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** Время в строке списка: сегодня — часы, на неделе — день, раньше — дата. */
export function shortTime(iso: string, now = new Date()) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const days = Math.round((startOfDay(now).getTime() - startOfDay(d).getTime()) / 86400000);
  if (days <= 0) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (days < 7) return WEEKDAYS_SHORT[d.getDay()];
  if (d.getFullYear() === now.getFullYear()) return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${String(d.getFullYear()).slice(2)}`;
}
/** «Изменено сегодня в 19:42». */
export function changedLabel(iso: string, now = new Date()) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const days = Math.round((startOfDay(now).getTime() - startOfDay(d).getTime()) / 86400000);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (days <= 0) return `Изменено сегодня в ${time}`;
  if (days === 1) return `Изменено вчера в ${time}`;
  return `Изменено ${dayMonth(d)}${d.getFullYear() !== now.getFullYear() ? ' ' + d.getFullYear() : ''} в ${time}`;
}

export interface Group<T> {
  key: string;
  title: string;
  hint: string;
  items: T[];
}
/** Группы списка: Сегодня, Вчера, На этой неделе, затем по месяцам. */
export function groupByDay<T extends { updatedAt: string }>(items: T[], now = new Date()): Group<T>[] {
  const today = startOfDay(now);
  const weekday = (today.getDay() + 6) % 7; // понедельник = 0
  const weekStart = new Date(today.getTime() - weekday * 86400000);
  const groups = new Map<string, Group<T>>();
  for (const item of items) {
    const d = new Date(item.updatedAt);
    const day = startOfDay(Number.isNaN(d.getTime()) ? new Date(0) : d);
    const diff = Math.round((today.getTime() - day.getTime()) / 86400000);
    let key: string, title: string, hint: string;
    if (diff <= 0) [key, title, hint] = ['today', 'Сегодня', dayMonth(today)];
    else if (diff === 1) [key, title, hint] = ['yesterday', 'Вчера', dayMonth(day)];
    else if (day >= weekStart) [key, title, hint] = ['week', 'На этой неделе', ''];
    else {
      key = `${day.getFullYear()}-${day.getMonth()}`;
      title = MONTH_NAMES[day.getMonth()];
      hint = String(day.getFullYear());
    }
    let group = groups.get(key);
    if (!group) groups.set(key, (group = { key, title, hint, items: [] }));
    group.items.push(item);
  }
  return [...groups.values()];
}

/** Срок задачи: «Сегодня», «Завтра», «12 ноя»; overdue — просрочено. */
export function dueLabel(due: string, today = localDate()) {
  const day = dueDay(due);
  const overdue = day < today;
  if (day === today) return { text: 'Сегодня', overdue, today: true };
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const tomorrow = new Date(Date.now() + 86400000);
  if (localDate(tomorrow) === day) return { text: 'Завтра', overdue, today: false };
  return { text: `${d} ${MONTHS_SHORT[date.getMonth()]}`, overdue, today: false };
}

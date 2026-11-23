/**
 * Напоминания о задачах — локальные уведомления телефона (сервер и сеть не нужны).
 * Каждый день, на который есть задачи со сроком, в выбранное время приходит сводка;
 * в сегодняшнюю попадают и просроченные. Планируем на 14 дней вперёд и пересчитываем
 * при изменении задач. Настройки — на устройстве (LocalStore, ключ `reminders`).
 */
import { useEffect, useRef, useState } from 'react';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { dueDay, localDate } from '@selfnote/shared';
import type { Workspace } from './sync/workspace';

export interface ReminderSettings {
  enabled: boolean;
  hour: number;
  minute: number;
}
export const DEFAULT_REMINDERS: ReminderSettings = { enabled: false, hour: 9, minute: 0 };
const DAYS = 14;

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export async function loadReminders(workspace: Workspace): Promise<ReminderSettings> {
  return { ...DEFAULT_REMINDERS, ...((await workspace.local<ReminderSettings>('reminders')) ?? {}) };
}
/** Включение просит разрешение iOS; false — пользователь не разрешил. */
export async function saveReminders(workspace: Workspace, settings: ReminderSettings) {
  if (settings.enabled) {
    const current = await Notifications.getPermissionsAsync();
    const granted =
      current.granted ||
      (await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowSound: true } })).granted;
    if (!granted) return false;
  }
  await workspace.setLocal('reminders', settings);
  await schedule(workspace, settings);
  return true;
}

function plural(n: number) {
  const a = n % 10,
    b = n % 100;
  if (a === 1 && b !== 11) return 'задача';
  if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return 'задачи';
  return 'задач';
}
const list = (texts: string[]) => {
  const shown = texts.slice(0, 4).map((t) => `• ${t || 'Без текста'}`);
  if (texts.length > 4) shown.push(`и ещё ${texts.length - 4}`);
  return shown.join('\n');
};

/** План уведомлений: [время, заголовок, текст]. */
function plan(workspace: Workspace, settings: ReminderSettings) {
  const now = new Date();
  const today = localDate(now);
  const open = workspace.allTasks().filter((t) => !t.checked && t.due);
  const result: { date: Date; title: string; body: string }[] = [];
  for (let offset = 0; offset < DAYS; offset++) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, settings.hour, settings.minute);
    if (date <= now) continue;
    const day = localDate(date);
    const due = open.filter((t) => dueDay(t.due!) === day);
    // просроченные напоминаем в первой будущей сводке, если она сегодня
    const overdue = day === today ? open.filter((t) => dueDay(t.due!) < today) : [];
    if (!due.length && !overdue.length) continue;
    const title =
      day === today ? 'Задачи на сегодня' : offset === 1 ? 'Задачи на завтра' : `Задачи на ${date.getDate()}.${String(date.getMonth() + 1).padStart(2, '0')}`;
    const parts = [];
    if (due.length) parts.push(`${due.length} ${plural(due.length)}\n${list(due.map((t) => t.text))}`);
    if (overdue.length) parts.push(`Просрочено: ${overdue.length}\n${list(overdue.map((t) => t.text))}`);
    result.push({ date, title, body: parts.join('\n') });
  }
  return result;
}

let lastKey = '';
async function schedule(workspace: Workspace, settings: ReminderSettings) {
  const items = settings.enabled ? plan(workspace, settings) : [];
  const key = JSON.stringify(items.map((i) => [i.date.getTime(), i.title, i.body]));
  if (key === lastKey) return;
  lastKey = key;
  await Notifications.cancelAllScheduledNotificationsAsync();
  for (const item of items)
    await Notifications.scheduleNotificationAsync({
      content: { title: item.title, body: item.body, data: { url: '/tasks' } },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: item.date },
    });
}

/** Держит расписание в актуальном виде, пока открыт аккаунт; нажатие на уведомление открывает «Задачи». */
export function useReminders(workspace: Workspace | null) {
  const [settings, setSettings] = useState<ReminderSettings | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (!workspace) return;
    let alive = true;
    const reload = () => void loadReminders(workspace).then((s) => alive && setSettings(s));
    reload();
    const off = workspace.onLocalChange('reminders', reload);
    return () => {
      alive = false;
      off();
    };
  }, [workspace]);
  useEffect(() => {
    if (!workspace || !settings) return;
    const run = () => {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void schedule(workspace, settings).catch(() => undefined), 2000);
    };
    run();
    const off = workspace.subscribe(run);
    return () => {
      off();
      clearTimeout(timer.current);
    };
  }, [workspace, settings]);
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const url = response.notification.request.content.data?.url;
      if (typeof url === 'string') router.navigate(url as '/tasks');
    });
    return () => sub.remove();
  }, []);
}

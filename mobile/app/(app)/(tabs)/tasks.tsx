import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { ChevronDown, ChevronUp } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { dueDay, localDate } from '@selfnote/shared';
import { useWorkspace } from '../../../src/session';
import type { TaskRow } from '../../../src/sync/workspace';
import { Card, Checkbox, DueBadge, OfflineBanner, SectionTitle } from '../../../src/ui';
import { fonts, useTheme } from '../../../src/theme';

/** Вкладка «Задачи»: как в вебе — просрочено, сегодня, предстоящие, без срока, выполненные. */
export default function Tasks() {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const workspace = useWorkspace();
  const [showDone, setShowDone] = useState(false);
  const [reorder, setReorder] = useState(false);
  const today = localDate();
  const all = workspace.allTasks();
  const open = all.filter((t) => !t.checked);
  const byDue = (a: TaskRow, b: TaskRow) => dueDay(a.due!).localeCompare(dueDay(b.due!));
  const groups: { title: string; items: TaskRow[] }[] = [
    { title: 'Просрочено', items: open.filter((t) => t.due && dueDay(t.due) < today).sort(byDue) },
    { title: 'Сегодня', items: open.filter((t) => t.due && dueDay(t.due) === today) },
    { title: 'Предстоящие', items: open.filter((t) => t.due && dueDay(t.due) > today).sort(byDue) },
    {
      title: 'Без срока',
      // ручной порядок (как в вебе): сначала упорядоченные, остальные — как в заметках
      items: open
        .filter((t) => !t.due)
        .map((t, index) => ({ t, index }))
        .sort((a, b) => (a.t.order ?? Infinity) - (b.t.order ?? Infinity) || a.index - b.index)
        .map((e) => e.t),
    },
  ];
  const done = all
    .filter((t) => t.checked)
    .sort((a, b) => (b.doneAt ?? '').localeCompare(a.doneAt ?? ''))
    .slice(0, 50);

  const noDue = groups[3].items;
  const move = (index: number, delta: number) => {
    const keys = noDue.map((t) => `${t.noteId}:${t.id}`);
    const target = index + delta;
    if (target < 0 || target >= keys.length) return;
    [keys[index], keys[target]] = [keys[target], keys[index]];
    workspace.setTaskOrder(keys);
  };
  const row = (task: TaskRow, index: number, movable = false) => (
    <View
      key={task.noteId + task.id}
      style={[styles.task, index > 0 && { borderTopWidth: 1, borderTopColor: c.line }]}
    >
      <Checkbox
        checked={task.checked}
        label={task.text}
        disabled={!workspace.canEdit(task.noteId)}
        onChange={(v) => workspace.setTask(task.noteId, task.id, v)}
      />
      <Pressable
        style={{ flex: 1 }}
        onPress={() => router.push({ pathname: '/note/[id]', params: { id: task.noteId } })}
      >
        <Text
          style={[
            styles.text,
            { color: task.checked ? c.faint : c.text },
            task.checked && { textDecorationLine: 'line-through' },
          ]}
        >
          {task.text || 'Без текста'}
        </Text>
        <Text style={[styles.note, { color: c.muted }]} numberOfLines={1}>
          {task.noteTitle}
        </Text>
      </Pressable>
      {task.due && !task.checked ? <DueBadge due={task.due} /> : null}
      {movable ? (
        <View style={styles.arrows}>
          <Pressable
            onPress={() => move(index, -1)}
            disabled={index === 0}
            style={[styles.arrow, index === 0 && { opacity: 0.3 }]}
            accessibilityRole="button"
            accessibilityLabel="Выше"
          >
            <ChevronUp color={c.text} size={20} />
          </Pressable>
          <Pressable
            onPress={() => move(index, 1)}
            disabled={index === noDue.length - 1}
            style={[styles.arrow, index === noDue.length - 1 && { opacity: 0.3 }]}
            accessibilityRole="button"
            accessibilityLabel="Ниже"
          >
            <ChevronDown color={c.text} size={20} />
          </Pressable>
        </View>
      ) : null}
    </View>
  );

  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentContainerStyle={{ paddingTop: insets.top + 10, paddingBottom: 32 }}
    >
      <Text style={[styles.title, { color: c.text }]} accessibilityRole="header">
        Задачи
      </Text>
      <OfflineBanner workspace={workspace} />
      <View style={styles.body}>
        {groups
          .filter((g) => g.items.length)
          .map((g) => (
            <View key={g.title}>
              {g.title === 'Без срока' && g.items.length > 1 ? (
                <Pressable onPress={() => setReorder((v) => !v)} accessibilityRole="button">
                  <SectionTitle title={g.title} hint={reorder ? 'Готово' : 'Порядок'} />
                </Pressable>
              ) : (
                <SectionTitle title={g.title} hint={String(g.items.length)} />
              )}
              <Card style={{ paddingHorizontal: 16 }}>
                {g.items.map((t, i) => row(t, i, reorder && g.title === 'Без срока'))}
              </Card>
            </View>
          ))}
        {!open.length ? (
          <Text style={[styles.empty, { color: c.secondary }]}>Все задачи выполнены</Text>
        ) : null}
        {done.length ? (
          <View>
            <Pressable onPress={() => setShowDone((v) => !v)} accessibilityRole="button">
              <SectionTitle title={showDone ? 'Скрыть выполненные' : 'Показать выполненные'} hint={String(done.length)} />
            </Pressable>
            {showDone ? (
              <Card style={{ paddingHorizontal: 16 }}>{done.map((t, i) => row(t, i))}</Card>
            ) : null}
          </View>
        ) : null}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  title: { fontFamily: fonts.heavy, fontSize: 34, letterSpacing: -1.2, paddingHorizontal: 20, paddingBottom: 14 },
  body: { paddingHorizontal: 16, gap: 18 },
  task: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 54, paddingVertical: 8 },
  text: { fontFamily: fonts.regular, fontSize: 16 },
  note: { fontFamily: fonts.regular, fontSize: 13, marginTop: 1 },
  arrows: { flexDirection: 'row' },
  arrow: { width: 36, height: 40, alignItems: 'center', justifyContent: 'center' },
  empty: { fontFamily: fonts.medium, fontSize: 16, textAlign: 'center', paddingVertical: 40 },
});

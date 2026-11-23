import { useEffect, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Pin, Search, X } from 'lucide-react-native';
import { searchTerms } from '@selfnote/shared';
import { useSession, useWorkspace } from '../../../src/session';
import { groupByDay, todayLabel } from '../../../src/dates';
import { Card, Checkbox, DueBadge, NoteRow, OfflineBanner, SectionTitle } from '../../../src/ui';
import { fonts, useTheme } from '../../../src/theme';

export default function Notes() {
  const theme = useTheme();
  const { c } = theme;
  const insets = useSafeAreaInsets();
  const workspace = useWorkspace();
  const session = useSession();
  const params = useLocalSearchParams<{ notebook?: string; section?: string }>();
  const [notebookId, setNotebookId] = useState<string | null>(params.notebook ?? null);
  const [sectionId, setSectionId] = useState<string | null>(params.section ?? null);
  const [query, setQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    setNotebookId(params.notebook ?? null);
    setSectionId(params.section ?? null);
  }, [params.notebook, params.section]);

  const user = session.status === 'signedIn' ? session.account.user : null;
  const initials = (user?.name ?? '?')
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  const notebooks = workspace.notebooks();
  const sections = notebookId ? workspace.sections(notebookId) : [];
  const terms = searchTerms(query);
  const notes = workspace.visibleNotes().filter((note) => {
    if (notebookId && note.notebookId !== notebookId) return false;
    if (sectionId && note.sectionId !== sectionId) return false;
    if (!terms.length) return true;
    const haystack = (note.title + ' ' + workspace.extract(note.id).plainText).toLowerCase();
    return terms.every((t) => haystack.includes(t));
  });
  const pinned = terms.length ? [] : notes.filter((n) => n.pinned);
  const rest = terms.length ? notes : notes.filter((n) => !n.pinned);
  const groups = groupByDay(rest);
  const tasks = terms.length || notebookId ? [] : workspace.todayTasks().slice(0, 5);

  const open = (id: string) => router.push({ pathname: '/note/[id]', params: { id } });
  const chip = (active: boolean) => [
    styles.chip,
    active ? { backgroundColor: c.strong } : { backgroundColor: c.panel, borderColor: c.border, borderWidth: 1 },
  ];
  const chipText = (active: boolean) => [styles.chipText, { color: active ? c.onStrong : c.text }];

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <ScrollView
        contentContainerStyle={{ paddingTop: insets.top + 10, paddingBottom: 32 }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        stickyHeaderIndices={[1]}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              workspace.wake();
              setTimeout(() => setRefreshing(false), 800);
            }}
          />
        }
      >
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.date, { color: c.secondary }]}>{todayLabel()}</Text>
            <Text style={[styles.title, { color: c.text }]} accessibilityRole="header">
              Заметки
            </Text>
          </View>
          <Pressable
            onPress={() => router.navigate('/settings')}
            accessibilityRole="button"
            accessibilityLabel={`Профиль: ${user?.name ?? ''}`}
            style={[styles.avatar, { backgroundColor: theme.tint }]}
          >
            <Text style={[styles.avatarText, { color: theme.accentText }]}>{initials}</Text>
            <View
              style={[
                styles.status,
                {
                  borderColor: c.background,
                  backgroundColor:
                    workspace.connection === 'online'
                      ? workspace.unsynced
                        ? '#A66A18'
                        : c.success
                      : workspace.connection === 'connecting'
                        ? c.faint
                        : c.danger,
                },
              ]}
            />
          </Pressable>
        </View>

        <View style={{ backgroundColor: c.background, paddingBottom: 4 }}>
          <View style={[styles.search, { backgroundColor: c.panel, borderColor: c.border }]}>
            <Search color={c.muted} size={20} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Поиск по заметкам и задачам"
              placeholderTextColor={c.faint}
              style={[styles.searchInput, { color: c.text }]}
              returnKeyType="search"
              clearButtonMode="never"
              accessibilityLabel="Поиск по заметкам"
            />
            {query ? (
              <Pressable onPress={() => setQuery('')} hitSlop={10} accessibilityLabel="Очистить поиск">
                <X color={c.muted} size={18} />
              </Pressable>
            ) : null}
          </View>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.chips}
            accessibilityLabel="Записные книжки"
          >
            <Pressable
              style={chip(!notebookId)}
              onPress={() => {
                setNotebookId(null);
                setSectionId(null);
              }}
              accessibilityRole="button"
              accessibilityState={{ selected: !notebookId }}
            >
              <Text style={chipText(!notebookId)}>Все</Text>
              <Text style={[chipText(!notebookId), { opacity: 0.7 }]}>
                {workspace.visibleNotes().length}
              </Text>
            </Pressable>
            {notebooks.map((nb) => {
              const active = notebookId === nb.id;
              return (
                <Pressable
                  key={nb.id}
                  style={chip(active)}
                  onPress={() => {
                    setNotebookId(active ? null : nb.id);
                    setSectionId(null);
                  }}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                >
                  <View style={[styles.swatch, { backgroundColor: nb.color || theme.accent }]} />
                  <Text style={chipText(active)}>{nb.name}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
          {sections.length ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.subchips}>
              {sections.map((s) => {
                const active = sectionId === s.id;
                return (
                  <Pressable
                    key={s.id}
                    onPress={() => setSectionId(active ? null : s.id)}
                    style={[styles.subchip, active && { backgroundColor: theme.tint }]}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                  >
                    <Text style={[styles.subchipText, { color: active ? theme.accentText : c.secondary }]}>
                      {s.name}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          ) : null}
        </View>

        <OfflineBanner workspace={workspace} />

        <View style={styles.body}>
          {tasks.length ? (
            <Card style={{ padding: 16, paddingBottom: 6 }}>
              <View style={styles.cardHead}>
                <Text style={[styles.cardTitle, { color: c.text }]}>Сегодня в задачах</Text>
                <Pressable onPress={() => router.navigate('/tasks')} accessibilityRole="button">
                  <Text style={[styles.counter, { color: theme.accentText, backgroundColor: theme.tint }]}>
                    {workspace.todayTasks().length} {plural(workspace.todayTasks().length, 'задача', 'задачи', 'задач')}
                  </Text>
                </Pressable>
              </View>
              {tasks.map((task, index) => (
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
                  <Pressable style={{ flex: 1 }} onPress={() => open(task.noteId)}>
                    <Text style={[styles.taskText, { color: c.text }]} numberOfLines={2}>
                      {task.text || 'Без текста'}
                    </Text>
                    <Text style={[styles.taskNote, { color: c.muted }]} numberOfLines={1}>
                      {task.noteTitle}
                    </Text>
                  </Pressable>
                  <DueBadge due={task.due!} />
                </View>
              ))}
            </Card>
          ) : null}

          {pinned.length ? (
            <View>
              <SectionTitle title="Закреплённые" icon={<Pin color={c.secondary} size={14} />} />
              <Card>
                {pinned.map((note, i) => (
                  <NoteRow key={note.id} note={note} workspace={workspace} first={i === 0} onPress={() => open(note.id)} />
                ))}
              </Card>
            </View>
          ) : null}

          {terms.length ? (
            <SectionTitle title={notes.length ? `Найдено: ${notes.length}` : 'Ничего не найдено'} />
          ) : null}
          {groups.map((group) =>
            terms.length ? (
              <Card key={group.key}>
                {group.items.map((note, i) => (
                  <NoteRow key={note.id} note={note} workspace={workspace} first={i === 0} onPress={() => open(note.id)} />
                ))}
              </Card>
            ) : (
              <View key={group.key}>
                <SectionTitle title={group.title} hint={group.hint} />
                <Card>
                  {group.items.map((note, i) => (
                    <NoteRow key={note.id} note={note} workspace={workspace} first={i === 0} onPress={() => open(note.id)} />
                  ))}
                </Card>
              </View>
            ),
          )}

          {!notes.length && !terms.length ? (
            <View style={styles.empty}>
              <Text style={[styles.emptyTitle, { color: c.text }]}>Здесь пока пусто</Text>
              <Text style={[styles.emptyText, { color: c.secondary }]}>
                {workspace.connection === 'online'
                  ? 'Создавайте заметки в веб-версии — они появятся здесь.'
                  : 'Заметки загрузятся, когда появится связь с сервером.'}
              </Text>
            </View>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}

function plural(n: number, one: string, few: string, many: string) {
  const a = n % 10,
    b = n % 100;
  if (a === 1 && b !== 11) return one;
  if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return few;
  return many;
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingBottom: 12 },
  date: { fontFamily: fonts.medium, fontSize: 14 },
  title: { fontFamily: fonts.heavy, fontSize: 34, letterSpacing: -1.2 },
  avatar: { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontFamily: fonts.bold, fontSize: 15 },
  status: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    width: 13,
    height: 13,
    borderRadius: 7,
    borderWidth: 2,
  },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    height: 48,
    marginHorizontal: 20,
    paddingHorizontal: 16,
    borderRadius: 16,
    borderWidth: 1,
  },
  searchInput: { flex: 1, fontFamily: fonts.regular, fontSize: 16, height: '100%' },
  chips: { gap: 8, paddingHorizontal: 20, paddingTop: 12, paddingBottom: 8 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 40,
    paddingHorizontal: 15,
    borderRadius: 999,
  },
  chipText: { fontFamily: fonts.semibold, fontSize: 15 },
  swatch: { width: 10, height: 10, borderRadius: 3 },
  subchips: { gap: 4, paddingHorizontal: 20, paddingBottom: 8 },
  subchip: { height: 34, paddingHorizontal: 12, borderRadius: 10, justifyContent: 'center' },
  subchipText: { fontFamily: fonts.medium, fontSize: 15 },
  body: { paddingHorizontal: 16, paddingTop: 6, gap: 18 },
  cardHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  cardTitle: { fontFamily: fonts.bold, fontSize: 17, letterSpacing: -0.3 },
  counter: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    overflow: 'hidden',
  },
  task: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52, paddingVertical: 8 },
  taskText: { fontFamily: fonts.regular, fontSize: 16 },
  taskNote: { fontFamily: fonts.regular, fontSize: 13, marginTop: 1 },
  empty: { alignItems: 'center', paddingVertical: 60, paddingHorizontal: 30, gap: 8 },
  emptyTitle: { fontFamily: fonts.bold, fontSize: 20 },
  emptyText: { fontFamily: fonts.regular, fontSize: 16, textAlign: 'center', lineHeight: 22 },
});

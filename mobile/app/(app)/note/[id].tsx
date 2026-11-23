import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronLeft, Ellipsis, Lock, Users } from 'lucide-react-native';
import { NoteMenu } from '../../../src/NoteMenu';
import { useWorkspace } from '../../../src/session';
import { changedLabel } from '../../../src/dates';
import { NoteEditor, editorAvailable } from '../../../src/editor/NoteEditor';
import { NoteView } from '../../../src/NoteView';
import { OfflineBanner } from '../../../src/ui';
import { fonts, useTheme } from '../../../src/theme';

export default function NoteScreen() {
  const theme = useTheme();
  const { c } = theme;
  const insets = useSafeAreaInsets();
  const workspace = useWorkspace();
  const { id, created } = useLocalSearchParams<{ id: string; created?: string }>();
  const note = workspace.metadata.get(id);
  const [ready, setReady] = useState(workspace.isLoaded(id));
  const [menu, setMenu] = useState(false);
  const openable = !!note && !note.encrypted;

  useEffect(() => {
    if (!openable) return;
    let alive = true;
    void workspace.note(id).ready.then(() => alive && setReady(true));
    return () => {
      alive = false;
    };
  }, [id, openable, workspace]);
  // Пустую новую заметку не оставляем в списке.
  useEffect(() => () => workspace.discardIfEmpty(id), [id, workspace]);

  const back = () => (router.canGoBack() ? router.back() : router.replace('/'));
  const notebook = workspace.notebook(note?.notebookId);
  const section = workspace.section(note?.sectionId);
  const place = [notebook?.name, section?.name].filter(Boolean).join(' / ');
  const editable = workspace.canEdit(id);

  return (
    <View style={{ flex: 1, backgroundColor: c.panel }}>
      <View style={[styles.bar, { paddingTop: insets.top + 4 }]}>
        <Pressable onPress={back} style={styles.back} accessibilityRole="button" accessibilityLabel="Назад к заметкам">
          <ChevronLeft color={theme.accentText} size={26} strokeWidth={2.2} />
          <Text style={[styles.backText, { color: theme.accentText }]}>Заметки</Text>
        </Pressable>
        <View style={styles.meta}>
          {workspace.isCollaborative(id) ? (
            <View style={styles.flag}>
              <Users color={c.secondary} size={15} />
              <Text style={[styles.flagText, { color: c.secondary }]}>
                {editable ? 'Совместная' : 'Только чтение'}
              </Text>
            </View>
          ) : null}
          {place ? (
            <View style={[styles.place, { backgroundColor: theme.tint }]}>
              <View style={[styles.swatch, { backgroundColor: notebook?.color || theme.accent }]} />
              <Text style={[styles.placeText, { color: theme.accentText }]} numberOfLines={1}>
                {place}
              </Text>
            </View>
          ) : null}
        </View>
        {note && workspace.isOwner(id) ? (
          <Pressable
            onPress={() => setMenu(true)}
            hitSlop={6}
            style={styles.more}
            accessibilityRole="button"
            accessibilityLabel="Меню заметки"
          >
            <Ellipsis color={c.text} size={24} />
          </Pressable>
        ) : null}
      </View>
      <OfflineBanner workspace={workspace} />
      <NoteMenu id={menu ? id : null} onClose={() => setMenu(false)} onTrashed={back} />
      {!note ? (
        <Text style={[styles.missing, { color: c.secondary }]}>Заметка удалена или доступ к ней закрыт.</Text>
      ) : note.encrypted ? (
        <View style={[styles.locked, { backgroundColor: c.soft }]}>
          <Lock color={c.secondary} size={26} />
          <Text style={[styles.lockedText, { color: c.secondary }]}>
            Заметка защищена паролем. Такие заметки приложение пока не открывает — откройте её в
            веб-версии.
          </Text>
        </View>
      ) : !ready ? (
        <ActivityIndicator style={{ marginTop: 40 }} />
      ) : editorAvailable ? (
        <View style={{ flex: 1 }}>
          <NoteEditor workspace={workspace} id={id} doc={workspace.note(id).doc} focusTitle={created === '1'} />
        </View>
      ) : (
        <ScrollView contentContainerStyle={[styles.page, { paddingBottom: insets.bottom + 40 }]}>
          <Text style={[styles.title, { color: c.text }]} accessibilityRole="header">
            {note.title || 'Без названия'}
          </Text>
          <Text style={[styles.changed, { color: c.muted }]}>{changedLabel(note.updatedAt)}</Text>
          <NoteView
            doc={workspace.note(id).doc}
            canEdit={editable}
            onTask={(taskId, checked) => workspace.setTask(id, taskId, checked)}
          />
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingBottom: 4, gap: 8 },
  back: { flexDirection: 'row', alignItems: 'center', height: 44, paddingRight: 6 },
  backText: { fontFamily: fonts.medium, fontSize: 17 },
  more: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  meta: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 10, paddingRight: 8 },
  place: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 11, paddingVertical: 5, borderRadius: 999, flexShrink: 1 },
  swatch: { width: 9, height: 9, borderRadius: 3 },
  placeText: { fontFamily: fonts.semibold, fontSize: 14, flexShrink: 1 },
  flag: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  flagText: { fontFamily: fonts.medium, fontSize: 14 },
  page: { paddingHorizontal: 22, paddingTop: 6 },
  title: { fontFamily: fonts.heavy, fontSize: 32, lineHeight: 36, letterSpacing: -1.1, marginTop: 6 },
  changed: { fontFamily: fonts.regular, fontSize: 14, marginTop: 4, marginBottom: 18 },
  missing: { fontFamily: fonts.medium, fontSize: 16, textAlign: 'center', padding: 40 },
  locked: { alignItems: 'center', gap: 12, padding: 24, borderRadius: 20, margin: 22 },
  lockedText: { fontFamily: fonts.regular, fontSize: 16, lineHeight: 23, textAlign: 'center' },
});

import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronLeft, Lock, Users } from 'lucide-react-native';
import { useWorkspace } from '../../../src/session';
import { changedLabel } from '../../../src/dates';
import { NoteView } from '../../../src/NoteView';
import { OfflineBanner } from '../../../src/ui';
import { fonts, useTheme } from '../../../src/theme';

export default function NoteScreen() {
  const theme = useTheme();
  const { c } = theme;
  const insets = useSafeAreaInsets();
  const workspace = useWorkspace();
  const { id } = useLocalSearchParams<{ id: string }>();
  const note = workspace.metadata.get(id);
  const [ready, setReady] = useState(workspace.isLoaded(id));

  const openable = !!note && !note.encrypted;
  useEffect(() => {
    if (!openable) return;
    let alive = true;
    void workspace.note(id).ready.then(() => alive && setReady(true));
    return () => {
      alive = false;
    };
  }, [id, openable, workspace]);

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
      </View>
      <OfflineBanner workspace={workspace} />
      {!note ? (
        <Text style={[styles.missing, { color: c.secondary }]}>
          Заметка удалена или доступ к ней закрыт.
        </Text>
      ) : (
        <ScrollView contentContainerStyle={[styles.page, { paddingBottom: insets.bottom + 40 }]}>
          <View style={styles.meta}>
            {place ? (
              <View style={[styles.place, { backgroundColor: theme.tint }]}>
                <View style={[styles.swatch, { backgroundColor: notebook?.color || theme.accent }]} />
                <Text style={[styles.placeText, { color: theme.accentText }]} numberOfLines={1}>
                  {place}
                </Text>
              </View>
            ) : null}
            {workspace.isCollaborative(id) ? (
              <View style={styles.flag}>
                <Users color={c.secondary} size={15} />
                <Text style={[styles.flagText, { color: c.secondary }]}>
                  {editable ? 'Совместная' : 'Только чтение'}
                </Text>
              </View>
            ) : null}
          </View>
          <Text style={[styles.title, { color: c.text }]} accessibilityRole="header">
            {note.encrypted && note.hideTitle ? 'Заметка под паролем' : note.title || 'Без названия'}
          </Text>
          <Text style={[styles.changed, { color: c.muted }]}>{changedLabel(note.updatedAt)}</Text>

          {note.encrypted ? (
            <View style={[styles.locked, { backgroundColor: c.soft }]}>
              <Lock color={c.secondary} size={26} />
              <Text style={[styles.lockedText, { color: c.secondary }]}>
                Заметка защищена паролем. Открытие таких заметок появится в приложении на следующем шаге —
                пока откройте её в веб-версии.
              </Text>
            </View>
          ) : !ready ? (
            <ActivityIndicator style={{ marginTop: 40 }} />
          ) : (
            <NoteView
              doc={workspace.note(id).doc}
              canEdit={editable}
              onTask={(taskId, checked) => workspace.setTask(id, taskId, checked)}
            />
          )}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { paddingHorizontal: 8, paddingBottom: 4 },
  back: { flexDirection: 'row', alignItems: 'center', height: 44, alignSelf: 'flex-start', paddingRight: 10 },
  backText: { fontFamily: fonts.medium, fontSize: 17 },
  page: { paddingHorizontal: 22, paddingTop: 6 },
  meta: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 10 },
  place: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 11,
    paddingVertical: 5,
    borderRadius: 999,
    maxWidth: '100%',
  },
  swatch: { width: 9, height: 9, borderRadius: 3 },
  placeText: { fontFamily: fonts.semibold, fontSize: 14 },
  flag: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  flagText: { fontFamily: fonts.medium, fontSize: 14 },
  title: { fontFamily: fonts.heavy, fontSize: 32, lineHeight: 36, letterSpacing: -1.1, marginTop: 14 },
  changed: { fontFamily: fonts.regular, fontSize: 14, marginTop: 4, marginBottom: 18 },
  missing: { fontFamily: fonts.medium, fontSize: 16, textAlign: 'center', padding: 40 },
  locked: { alignItems: 'center', gap: 12, padding: 24, borderRadius: 20, marginTop: 10 },
  lockedText: { fontFamily: fonts.regular, fontSize: 16, lineHeight: 23, textAlign: 'center' },
});

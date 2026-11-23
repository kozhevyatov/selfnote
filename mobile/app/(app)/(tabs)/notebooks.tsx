import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronRight } from 'lucide-react-native';
import { useWorkspace } from '../../../src/session';
import { Card } from '../../../src/ui';
import { fonts, useTheme } from '../../../src/theme';

/** Записные книжки с подразделами; нажатие открывает отфильтрованный список заметок. */
export default function Notebooks() {
  const theme = useTheme();
  const { c } = theme;
  const insets = useSafeAreaInsets();
  const workspace = useWorkspace();
  const notes = workspace.visibleNotes();
  const count = (notebookId: string, sectionId?: string) =>
    notes.filter((n) => n.notebookId === notebookId && (!sectionId || n.sectionId === sectionId)).length;
  const go = (notebook: string, section?: string) =>
    router.navigate({ pathname: '/', params: section ? { notebook, section } : { notebook } });

  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentContainerStyle={{ paddingTop: insets.top + 10, paddingBottom: 32 }}
    >
      <Text style={[styles.title, { color: c.text }]} accessibilityRole="header">
        Записные книжки
      </Text>
      <View style={styles.body}>
        {workspace.notebooks().map((nb) => (
          <Card key={nb.id}>
            <Pressable
              onPress={() => go(nb.id)}
              style={({ pressed }) => [styles.row, pressed && { backgroundColor: theme.selection }]}
              accessibilityRole="button"
            >
              <View style={[styles.icon, { backgroundColor: nb.color || theme.accent }]} />
              <Text style={[styles.name, { color: c.text }]}>{nb.name}</Text>
              <Text style={[styles.count, { color: c.secondary }]}>{count(nb.id)}</Text>
              <ChevronRight color={c.faint} size={20} />
            </Pressable>
            {workspace.sections(nb.id).map((s) => (
              <Pressable
                key={s.id}
                onPress={() => go(nb.id, s.id)}
                style={({ pressed }) => [
                  styles.sub,
                  { borderTopColor: c.line },
                  pressed && { backgroundColor: theme.selection },
                ]}
                accessibilityRole="button"
              >
                <Text style={[styles.subName, { color: c.text }]}>{s.name}</Text>
                <Text style={[styles.count, { color: c.secondary }]}>{count(nb.id, s.id)}</Text>
              </Pressable>
            ))}
          </Card>
        ))}
        {!workspace.notebooks().length ? (
          <Text style={[styles.empty, { color: c.secondary }]}>
            Книжек пока нет. Их можно создать в настройках веб-версии.
          </Text>
        ) : null}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  title: { fontFamily: fonts.heavy, fontSize: 34, letterSpacing: -1.2, paddingHorizontal: 20, paddingBottom: 14 },
  body: { paddingHorizontal: 16, gap: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingHorizontal: 16 },
  icon: { width: 14, height: 14, borderRadius: 4 },
  name: { flex: 1, fontFamily: fonts.semibold, fontSize: 17 },
  count: { fontFamily: fonts.medium, fontSize: 15 },
  sub: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 48,
    paddingLeft: 42,
    paddingRight: 48,
    borderTopWidth: 1,
  },
  subName: { flex: 1, fontFamily: fonts.regular, fontSize: 16 },
  empty: { fontFamily: fonts.medium, fontSize: 16, textAlign: 'center', paddingVertical: 40 },
});

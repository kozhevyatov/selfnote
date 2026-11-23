import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArchiveRestore, ChevronLeft, Trash2 } from 'lucide-react-native';
import { useWorkspace } from '../../src/session';
import { shortTime } from '../../src/dates';
import { Card } from '../../src/ui';
import { fonts, useTheme } from '../../src/theme';

/** Корзина: восстановить или удалить навсегда. Сервер чистит её сам через 30 дней. */
export default function Trash() {
  const theme = useTheme();
  const { c } = theme;
  const insets = useSafeAreaInsets();
  const workspace = useWorkspace();
  const notes = workspace.trash();
  const daysLeft = (deletedAt: string | null) => {
    const left = 30 - Math.floor((Date.now() - Date.parse(String(deletedAt))) / 86400000);
    return Number.isFinite(left) ? Math.max(left, 0) : 30;
  };
  const removeForever = (ids: string[], what: string) =>
    Alert.alert(`Удалить ${what} навсегда?`, 'Восстановить будет нельзя ни на одном устройстве.', [
      { text: 'Отмена', style: 'cancel' },
      { text: 'Удалить', style: 'destructive', onPress: () => workspace.deleteForever(ids) },
    ]);

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <View style={[styles.bar, { paddingTop: insets.top + 4 }]}>
        <Pressable
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/settings'))}
          style={styles.back}
          accessibilityRole="button"
          accessibilityLabel="Назад"
        >
          <ChevronLeft color={theme.accentText} size={26} strokeWidth={2.2} />
          <Text style={[styles.backText, { color: theme.accentText }]}>Настройки</Text>
        </Pressable>
        {notes.length ? (
          <Pressable
            onPress={() => removeForever(notes.map((n) => n.id), 'все заметки из корзины')}
            style={styles.clear}
            accessibilityRole="button"
          >
            <Text style={[styles.clearText, { color: c.danger }]}>Очистить</Text>
          </Pressable>
        ) : null}
      </View>
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}>
        <Text style={[styles.title, { color: c.text }]} accessibilityRole="header">
          Корзина
        </Text>
        <View style={styles.body}>
          {notes.length ? (
            <Card>
              {notes.map((note, i) => (
                <View
                  key={note.id}
                  style={[styles.row, i > 0 && { borderTopWidth: 1, borderTopColor: c.line }]}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.name, { color: c.text }]} numberOfLines={1}>
                      {note.encrypted && note.hideTitle ? 'Заметка под паролем' : note.title || 'Без названия'}
                    </Text>
                    <Text style={[styles.meta, { color: c.muted }]}>
                      Удалена {shortTime(String(note.deletedAt))} · ещё {daysLeft(note.deletedAt)} дн.
                    </Text>
                  </View>
                  <Pressable
                    onPress={() => workspace.update(note.id, { deletedAt: null })}
                    style={styles.icon}
                    accessibilityRole="button"
                    accessibilityLabel="Восстановить"
                  >
                    <ArchiveRestore color={theme.accentText} size={22} />
                  </Pressable>
                  <Pressable
                    onPress={() => removeForever([note.id], 'заметку')}
                    style={styles.icon}
                    accessibilityRole="button"
                    accessibilityLabel="Удалить навсегда"
                  >
                    <Trash2 color={c.danger} size={21} />
                  </Pressable>
                </View>
              ))}
            </Card>
          ) : (
            <Text style={[styles.empty, { color: c.secondary }]}>Корзина пуста</Text>
          )}
          <Text style={[styles.hint, { color: c.muted }]}>
            Заметки удаляются из корзины автоматически через 30 дней.
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 8 },
  back: { flexDirection: 'row', alignItems: 'center', height: 44, paddingRight: 6 },
  backText: { fontFamily: fonts.medium, fontSize: 17 },
  clear: { height: 44, justifyContent: 'center', paddingHorizontal: 12 },
  clearText: { fontFamily: fonts.semibold, fontSize: 17 },
  title: { fontFamily: fonts.heavy, fontSize: 34, letterSpacing: -1.2, paddingHorizontal: 20, paddingBottom: 14 },
  body: { paddingHorizontal: 16, gap: 12 },
  row: { flexDirection: 'row', alignItems: 'center', paddingLeft: 16, paddingRight: 4, minHeight: 64 },
  name: { fontFamily: fonts.semibold, fontSize: 17 },
  meta: { fontFamily: fonts.regular, fontSize: 13, marginTop: 2 },
  icon: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  empty: { fontFamily: fonts.medium, fontSize: 16, textAlign: 'center', paddingVertical: 40 },
  hint: { fontFamily: fonts.regular, fontSize: 14, paddingHorizontal: 6, lineHeight: 20 },
});

import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Constants from 'expo-constants';
import { LogOut } from 'lucide-react-native';
import { logout } from '../../../src/auth';
import { useSession, useWorkspace } from '../../../src/session';
import { Card } from '../../../src/ui';
import { fonts, useTheme } from '../../../src/theme';

export default function Settings() {
  const theme = useTheme();
  const { c } = theme;
  const insets = useSafeAreaInsets();
  const session = useSession();
  const workspace = useWorkspace();
  if (session.status !== 'signedIn') return null;
  const { account } = session;
  const status =
    workspace.connection === 'online'
      ? workspace.unsynced
        ? 'Отправляем изменения…'
        : 'Синхронизировано'
      : workspace.connection === 'connecting'
        ? 'Подключаемся…'
        : 'Нет связи — работаем офлайн';

  function confirmLogout() {
    const warning = workspace.unsynced
      ? '\n\nЕсть изменения, которые ещё не дошли до сервера. После выхода они пропадут с этого телефона.'
      : '';
    Alert.alert('Выйти из аккаунта?', `Заметки останутся на сервере.${warning}`, [
      { text: 'Отмена', style: 'cancel' },
      { text: 'Выйти', style: 'destructive', onPress: () => void logout() },
    ]);
  }

  const line = (label: string, value: string, first = false) => (
    <View style={[styles.line, !first && { borderTopWidth: 1, borderTopColor: c.line }]}>
      <Text style={[styles.label, { color: c.secondary }]}>{label}</Text>
      <Text style={[styles.value, { color: c.text }]} numberOfLines={1} selectable>
        {value}
      </Text>
    </View>
  );

  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentContainerStyle={{ paddingTop: insets.top + 10, paddingBottom: 32 }}
    >
      <Text style={[styles.title, { color: c.text }]} accessibilityRole="header">
        Настройки
      </Text>
      <View style={styles.body}>
        <Card style={{ paddingHorizontal: 16 }}>
          {line('Имя', account.user.name, true)}
          {line('Почта', account.user.email)}
          {line('Сервер', account.server.replace(/^https?:\/\//, ''))}
          {line('Состояние', status)}
        </Card>
        <Text style={[styles.hint, { color: c.muted }]}>
          Тема, акцентный цвет и книжки настраиваются в веб-версии и сразу применяются здесь.
        </Text>
        <Card>
          <Pressable
            onPress={confirmLogout}
            style={({ pressed }) => [styles.action, pressed && { backgroundColor: c.dangerBg }]}
            accessibilityRole="button"
          >
            <LogOut color={c.danger} size={20} />
            <Text style={[styles.actionText, { color: c.danger }]}>Выйти из аккаунта</Text>
          </Pressable>
        </Card>
        <Text style={[styles.version, { color: c.faint }]}>
          SelfNote {Constants.expoConfig?.version ?? ''}
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  title: { fontFamily: fonts.heavy, fontSize: 34, letterSpacing: -1.2, paddingHorizontal: 20, paddingBottom: 14 },
  body: { paddingHorizontal: 16, gap: 14 },
  line: { minHeight: 52, justifyContent: 'center', paddingVertical: 8 },
  label: { fontFamily: fonts.medium, fontSize: 13 },
  value: { fontFamily: fonts.regular, fontSize: 17, marginTop: 2 },
  hint: { fontFamily: fonts.regular, fontSize: 14, paddingHorizontal: 6, lineHeight: 20 },
  action: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 54, paddingHorizontal: 16 },
  actionText: { fontFamily: fonts.semibold, fontSize: 17 },
  version: { fontFamily: fonts.regular, fontSize: 13, textAlign: 'center', marginTop: 8 },
});

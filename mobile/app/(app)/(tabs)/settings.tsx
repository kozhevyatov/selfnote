import { useEffect, useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Constants from 'expo-constants';
import { Bell, Check, ChevronRight, LogOut, Trash2 } from 'lucide-react-native';
import { logout } from '../../../src/auth';
import { useSession, useWorkspace } from '../../../src/session';
import { Card, SectionTitle } from '../../../src/ui';
import { DEFAULT_ACCENT, fonts, useTheme } from '../../../src/theme';
import {
  DEFAULT_REMINDERS,
  loadReminders,
  saveReminders,
  type ReminderSettings,
} from '../../../src/reminders';

/** Те же акценты, что в вебе (apps/web/src/theme.ts). */
const ACCENTS = ['#3451D1', '#C2410C', '#2B7A3D', '#7A3DB8'];
const THEMES = [
  { value: 'system', label: 'Как в системе' },
  { value: 'light', label: 'Светлая' },
  { value: 'dark', label: 'Тёмная' },
] as const;
const TIMES = Array.from({ length: 36 }, (_, i) => ({ hour: 6 + Math.floor(i / 2), minute: (i % 2) * 30 }));
const pad = (n: number) => String(n).padStart(2, '0');

export default function Settings() {
  const theme = useTheme();
  const { c } = theme;
  const insets = useSafeAreaInsets();
  const session = useSession();
  const workspace = useWorkspace();
  const [reminders, setReminders] = useState<ReminderSettings>(DEFAULT_REMINDERS);
  const [timePicker, setTimePicker] = useState(false);
  useEffect(() => {
    void loadReminders(workspace).then(setReminders);
  }, [workspace]);
  if (session.status !== 'signedIn') return null;
  const { account } = session;
  const status =
    workspace.connection === 'online'
      ? workspace.unsynced || workspace.secure.pending
        ? 'Отправляем изменения…'
        : 'Синхронизировано'
      : workspace.connection === 'connecting'
        ? 'Подключаемся…'
        : 'Нет связи — работаем офлайн';
  const appearance = workspace.appearance();
  const currentTheme = (appearance.theme as 'system' | 'light' | 'dark' | undefined) ?? 'system';
  const currentAccent = (appearance.accent ?? DEFAULT_ACCENT).toUpperCase();
  const trashCount = workspace.trash().length;

  async function updateReminders(next: ReminderSettings) {
    const ok = await saveReminders(workspace, next);
    if (!ok) {
      Alert.alert(
        'Уведомления выключены',
        'Разрешите уведомления для SelfNote в настройках iOS, чтобы получать напоминания.',
      );
      return;
    }
    setReminders(next);
  }
  function confirmLogout() {
    const warning =
      workspace.unsynced || workspace.secure.pending
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

        <View>
          <SectionTitle title="Напоминания" />
          <Card>
            <View style={styles.action}>
              <Bell color={c.text} size={20} />
              <Text style={[styles.actionText, { color: c.text }]}>Сводка задач</Text>
              <Switch
                value={reminders.enabled}
                onValueChange={(enabled) => void updateReminders({ ...reminders, enabled })}
                trackColor={{ true: theme.accent }}
                accessibilityLabel="Напоминания о задачах"
              />
            </View>
            {reminders.enabled ? (
              <Pressable
                onPress={() => setTimePicker(true)}
                style={({ pressed }) => [
                  styles.action,
                  { borderTopWidth: 1, borderTopColor: c.line },
                  pressed && { backgroundColor: c.soft },
                ]}
                accessibilityRole="button"
              >
                <Text style={[styles.actionText, { color: c.text, marginLeft: 34 }]}>Время</Text>
                <Text style={[styles.valueRight, { color: theme.accentText }]}>
                  {reminders.hour}:{pad(reminders.minute)}
                </Text>
              </Pressable>
            ) : null}
          </Card>
          <Text style={[styles.hint, { color: c.muted }]}>
            В выбранное время — список задач со сроком на этот день; в сегодняшнюю сводку попадают и
            просроченные. Работает и без связи с сервером.
          </Text>
        </View>

        <View>
          <SectionTitle title="Оформление" />
          <Card style={{ padding: 12, gap: 12 }}>
            <View style={styles.segments}>
              {THEMES.map((t) => {
                const active = currentTheme === t.value;
                return (
                  <Pressable
                    key={t.value}
                    onPress={() => workspace.setAppearance(t.value, appearance.accent ?? DEFAULT_ACCENT)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    style={[styles.segment, active && { backgroundColor: theme.tint }]}
                  >
                    <Text style={[styles.segmentText, { color: active ? theme.accentText : c.text }]}>
                      {t.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            <View style={styles.accents}>
              {ACCENTS.map((color) => {
                const active = currentAccent === color;
                return (
                  <Pressable
                    key={color}
                    onPress={() => workspace.setAppearance(currentTheme, color)}
                    accessibilityRole="button"
                    accessibilityLabel={`Акцентный цвет ${color}`}
                    accessibilityState={{ selected: active }}
                    style={[styles.swatch, { backgroundColor: color, borderColor: active ? c.text : 'transparent' }]}
                  >
                    {active ? <Check color="#FFFFFF" size={20} strokeWidth={3} /> : null}
                  </Pressable>
                );
              })}
            </View>
          </Card>
          <Text style={[styles.hint, { color: c.muted }]}>
            Тема и цвет общие для всех ваших устройств — меняются и в веб-версии.
          </Text>
        </View>

        <Card>
          <Pressable
            onPress={() => router.push('/trash')}
            style={({ pressed }) => [styles.action, pressed && { backgroundColor: c.soft }]}
            accessibilityRole="button"
          >
            <Trash2 color={c.text} size={20} />
            <Text style={[styles.actionText, { color: c.text }]}>Корзина</Text>
            {trashCount ? (
              <Text style={[styles.valueRight, { color: c.secondary }]}>{trashCount}</Text>
            ) : null}
            <ChevronRight color={c.faint} size={20} />
          </Pressable>
        </Card>

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

      <Modal visible={timePicker} transparent animationType="slide" onRequestClose={() => setTimePicker(false)}>
        <Pressable style={styles.overlay} onPress={() => setTimePicker(false)} accessibilityLabel="Закрыть" />
        <View style={[styles.sheet, { backgroundColor: c.panel, paddingBottom: insets.bottom + 10 }]}>
          <Text style={[styles.sheetTitle, { color: c.text }]}>Время сводки</Text>
          <ScrollView style={{ maxHeight: 380 }} contentContainerStyle={styles.times}>
            {TIMES.map((t) => {
              const active = t.hour === reminders.hour && t.minute === reminders.minute;
              return (
                <Pressable
                  key={`${t.hour}:${t.minute}`}
                  onPress={() => {
                    setTimePicker(false);
                    void updateReminders({ ...reminders, ...t });
                  }}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  style={[styles.time, { backgroundColor: active ? theme.accent : c.soft }]}
                >
                  <Text style={[styles.timeText, { color: active ? '#FFFFFF' : c.text }]}>
                    {t.hour}:{pad(t.minute)}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  title: { fontFamily: fonts.heavy, fontSize: 34, letterSpacing: -1.2, paddingHorizontal: 20, paddingBottom: 14 },
  body: { paddingHorizontal: 16, gap: 18 },
  line: { minHeight: 52, justifyContent: 'center', paddingVertical: 8 },
  label: { fontFamily: fonts.medium, fontSize: 13 },
  value: { fontFamily: fonts.regular, fontSize: 17, marginTop: 2 },
  hint: { fontFamily: fonts.regular, fontSize: 14, paddingHorizontal: 6, lineHeight: 20, marginTop: 8 },
  action: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 54, paddingHorizontal: 16 },
  actionText: { flex: 1, fontFamily: fonts.semibold, fontSize: 17 },
  valueRight: { fontFamily: fonts.semibold, fontSize: 17 },
  segments: { flexDirection: 'row', gap: 6 },
  segment: { flex: 1, height: 42, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  segmentText: { fontFamily: fonts.semibold, fontSize: 14 },
  accents: { flexDirection: 'row', gap: 12, paddingHorizontal: 4 },
  swatch: { width: 44, height: 44, borderRadius: 22, borderWidth: 3, alignItems: 'center', justifyContent: 'center' },
  version: { fontFamily: fonts.regular, fontSize: 13, textAlign: 'center', marginTop: 8 },
  overlay: { flex: 1, backgroundColor: '#00000055' },
  sheet: { borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 16 },
  sheetTitle: { fontFamily: fonts.bold, fontSize: 18, marginBottom: 12 },
  times: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  time: { width: '22.8%', height: 46, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  timeText: { fontFamily: fonts.semibold, fontSize: 16 },
});

import { ActivityIndicator, View } from 'react-native';
import { Stack } from 'expo-router';
import { useSession } from '../../src/session';
import { useTheme } from '../../src/theme';
import { useReminders } from '../../src/reminders';

export default function AppLayout() {
  const session = useSession();
  const { c } = useTheme();
  useReminders(session.status === 'signedIn' ? session.workspace : null);
  // Пространство открывается из локальной базы за доли секунды — даже без сети.
  if (session.status !== 'signedIn' || !session.workspace)
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.background }}>
        <ActivityIndicator />
      </View>
    );
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: c.background } }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="note/[id]" />
    </Stack>
  );
}

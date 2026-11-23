import { useEffect } from 'react';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import {
  useFonts,
  GolosText_400Regular,
  GolosText_500Medium,
  GolosText_600SemiBold,
  GolosText_700Bold,
  GolosText_800ExtraBold,
} from '@expo-google-fonts/golos-text';
import { SessionProvider, useSession } from '../src/session';
import { CryptoHost } from '../src/crypto/CryptoHost';
import { useTheme } from '../src/theme';

void SplashScreen.preventAutoHideAsync();

function Root() {
  const session = useSession();
  const theme = useTheme();
  const [fontsLoaded] = useFonts({
    GolosText_400Regular,
    GolosText_500Medium,
    GolosText_600SemiBold,
    GolosText_700Bold,
    GolosText_800ExtraBold,
  });
  const ready = fontsLoaded && session.status !== 'loading';
  useEffect(() => {
    if (ready) void SplashScreen.hideAsync();
  }, [ready]);
  if (!ready) return null;
  const signedIn = session.status === 'signedIn';
  return (
    <>
      <StatusBar style={theme.isDark ? 'light' : 'dark'} />
      <Stack
        screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.c.background } }}
      >
        <Stack.Protected guard={signedIn}>
          <Stack.Screen name="(app)" />
        </Stack.Protected>
        <Stack.Protected guard={!signedIn}>
          <Stack.Screen name="login" />
        </Stack.Protected>
      </Stack>
    </>
  );
}

export default function Layout() {
  return (
    <SafeAreaProvider>
      <SessionProvider>
        <Root />
        <CryptoHost />
      </SessionProvider>
    </SafeAreaProvider>
  );
}

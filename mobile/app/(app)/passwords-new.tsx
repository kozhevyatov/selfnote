import { useEffect, useRef } from 'react';
import { Pressable, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronLeft } from 'lucide-react-native';
import { useWorkspace } from '../../src/session';
import { VaultGate } from '../../src/passwords/VaultGate';
import { fonts, useTheme } from '../../src/theme';

/** Новая запись паролей: сначала мастер-пароль (если хранилище закрыто), потом создание. */
export default function NewPasswords() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const workspace = useWorkspace();
  const { notebook, section } = useLocalSearchParams<{ notebook?: string; section?: string }>();
  const started = useRef(false);
  const unlocked = workspace.vault.unlocked;
  useEffect(() => {
    if (!unlocked || started.current) return;
    started.current = true;
    void workspace.vault
      .create(notebook || null, section || null)
      .then((id) => router.replace({ pathname: '/note/[id]', params: { id } }))
      .catch(() => router.back());
  }, [unlocked, workspace, notebook, section]);
  return (
    <View style={{ flex: 1, backgroundColor: theme.c.panel, paddingTop: insets.top + 4 }}>
      <Pressable
        onPress={() => router.back()}
        style={{ flexDirection: 'row', alignItems: 'center', height: 44, paddingHorizontal: 8 }}
        accessibilityRole="button"
      >
        <ChevronLeft color={theme.accentText} size={26} strokeWidth={2.2} />
        <Text style={{ fontFamily: fonts.medium, fontSize: 17, color: theme.accentText }}>Отмена</Text>
      </Pressable>
      {unlocked ? null : <VaultGate workspace={workspace} />}
    </View>
  );
}

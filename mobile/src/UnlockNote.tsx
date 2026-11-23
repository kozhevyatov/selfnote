import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Lock } from 'lucide-react-native';
import { WrongPasswordError } from '@selfnote/shared';
import type { Workspace } from './sync/workspace';
import { fonts, useTheme } from './theme';

/** Пароль заметки спрашивается при открытии; расшифровка — на телефоне. */
export function UnlockNote({ workspace, id }: { workspace: Workspace; id: string }) {
  const theme = useTheme();
  const { c } = theme;
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit() {
    if (!password || busy) return;
    setBusy(true);
    setError('');
    try {
      await workspace.secure.unlock(id, password);
    } catch (e) {
      setError(e instanceof WrongPasswordError ? 'Неверный пароль' : (e as Error).message);
      setBusy(false);
    }
  }
  const isPasswords = workspace.metadata.get(id)?.kind === 'passwords';
  return (
    <View style={styles.page}>
      <View style={[styles.icon, { backgroundColor: theme.tint }]}>
        <Lock color={theme.accentText} size={26} />
      </View>
      <Text style={[styles.title, { color: c.text }]}>
        {isPasswords ? 'Пароли' : 'Заметка под паролем'}
      </Text>
      <Text style={[styles.text, { color: c.secondary }]}>
        Содержимое зашифровано и расшифровывается только на этом телефоне.
      </Text>
      <TextInput
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoFocus
        placeholder={isPasswords ? 'Мастер-пароль' : 'Пароль заметки'}
        placeholderTextColor={c.faint}
        textContentType="password"
        autoComplete="current-password"
        returnKeyType="go"
        onSubmitEditing={submit}
        style={[styles.input, { color: c.text, borderColor: c.border, backgroundColor: c.background }]}
        accessibilityLabel="Пароль заметки"
      />
      {error ? <Text style={[styles.error, { color: c.danger }]}>{error}</Text> : null}
      <Pressable
        onPress={submit}
        disabled={!password || busy}
        accessibilityRole="button"
        style={({ pressed }) => [
          styles.button,
          { backgroundColor: theme.accent, opacity: !password || busy ? 0.5 : pressed ? 0.85 : 1 },
        ]}
      >
        {busy ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.buttonText}>Открыть</Text>}
      </Pressable>
      {busy ? (
        <Text style={[styles.hint, { color: c.muted }]}>Проверяем пароль — это занимает пару секунд</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { padding: 24, paddingTop: 40, alignItems: 'stretch', gap: 12 },
  icon: { width: 60, height: 60, borderRadius: 20, alignItems: 'center', justifyContent: 'center', alignSelf: 'center' },
  title: { fontFamily: fonts.bold, fontSize: 22, textAlign: 'center', marginTop: 6 },
  text: { fontFamily: fonts.regular, fontSize: 16, lineHeight: 22, textAlign: 'center', marginBottom: 8 },
  input: { height: 52, borderWidth: 1, borderRadius: 14, paddingHorizontal: 14, fontFamily: fonts.regular, fontSize: 17 },
  error: { fontFamily: fonts.medium, fontSize: 15, textAlign: 'center' },
  button: { height: 52, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  buttonText: { fontFamily: fonts.semibold, fontSize: 17, color: '#FFFFFF' },
  hint: { fontFamily: fonts.regular, fontSize: 14, textAlign: 'center' },
});

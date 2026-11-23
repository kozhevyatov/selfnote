import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { KeyRound } from 'lucide-react-native';
import { WrongPasswordError } from '@selfnote/shared';
import type { Workspace } from '../sync/workspace';
import { fonts, useTheme } from '../theme';

/** Мастер-пароль хранилища: открыть или (если ещё не настроен) задать. */
export function VaultGate({ workspace }: { workspace: Workspace }) {
  const theme = useTheme();
  const { c } = theme;
  const [setup, setSetup] = useState<boolean | null>(null);
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    void workspace.vault
      .configuration()
      .then((payload) => setSetup(!payload))
      .catch(() => setSetup(false));
  }, [workspace]);

  async function submit() {
    if (!password || busy) return;
    if (setup && password !== repeat) return setError('Пароли не совпадают');
    setBusy(true);
    setError('');
    try {
      await workspace.vault.unlock(password, Boolean(setup));
    } catch (e) {
      setError(e instanceof WrongPasswordError ? 'Неверный мастер-пароль' : (e as Error).message);
      setBusy(false);
    }
  }
  if (setup === null) return <ActivityIndicator style={{ marginTop: 40 }} />;
  const input = [styles.input, { color: c.text, borderColor: c.border, backgroundColor: c.background }];
  return (
    <View style={styles.page}>
      <View style={[styles.icon, { backgroundColor: theme.tint }]}>
        <KeyRound color={theme.accentText} size={26} />
      </View>
      <Text style={[styles.title, { color: c.text }]}>{setup ? 'Новое хранилище паролей' : 'Пароли'}</Text>
      <Text style={[styles.text, { color: c.secondary }]}>
        {setup
          ? 'Придумайте мастер-пароль — не меньше 12 символов. Восстановить его нельзя: без него записи не открыть.'
          : 'Введите мастер-пароль. Хранилище закроется само через 5 минут без действий.'}
      </Text>
      <TextInput
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoFocus
        placeholder="Мастер-пароль"
        placeholderTextColor={c.faint}
        textContentType={setup ? 'newPassword' : 'password'}
        returnKeyType={setup ? 'next' : 'go'}
        onSubmitEditing={setup ? undefined : submit}
        style={input}
        accessibilityLabel="Мастер-пароль"
      />
      {setup ? (
        <TextInput
          value={repeat}
          onChangeText={setRepeat}
          secureTextEntry
          placeholder="Ещё раз"
          placeholderTextColor={c.faint}
          textContentType="newPassword"
          returnKeyType="go"
          onSubmitEditing={submit}
          style={input}
          accessibilityLabel="Повтор мастер-пароля"
        />
      ) : null}
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
        {busy ? (
          <ActivityIndicator color="#FFFFFF" />
        ) : (
          <Text style={styles.buttonText}>{setup ? 'Создать хранилище' : 'Открыть'}</Text>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { padding: 24, paddingTop: 40, gap: 12 },
  icon: { width: 60, height: 60, borderRadius: 20, alignItems: 'center', justifyContent: 'center', alignSelf: 'center' },
  title: { fontFamily: fonts.bold, fontSize: 22, textAlign: 'center', marginTop: 6 },
  text: { fontFamily: fonts.regular, fontSize: 16, lineHeight: 22, textAlign: 'center', marginBottom: 8 },
  input: { height: 52, borderWidth: 1, borderRadius: 14, paddingHorizontal: 14, fontFamily: fonts.regular, fontSize: 17 },
  error: { fontFamily: fonts.medium, fontSize: 15, textAlign: 'center' },
  button: { height: 52, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  buttonText: { fontFamily: fonts.semibold, fontSize: 17, color: '#FFFFFF' },
});

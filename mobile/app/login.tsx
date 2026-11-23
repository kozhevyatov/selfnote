import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Eye, EyeOff, KeyRound, Mail, Feather, Server } from 'lucide-react-native';
import { lastLogin, login } from '../src/auth';
import { fonts, useTheme } from '../src/theme';

export default function Login() {
  const theme = useTheme();
  const { c } = theme;
  const insets = useSafeAreaInsets();
  const [server, setServer] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const emailRef = useRef<React.ComponentRef<typeof TextInput>>(null);
  const passwordRef = useRef<React.ComponentRef<typeof TextInput>>(null);

  useEffect(() => {
    void lastLogin().then((last) => {
      if (!last) return;
      setServer((v) => v || last.server.replace(/^https:\/\//, ''));
      setEmail((v) => v || last.email);
    });
  }, []);

  const canSubmit = server.trim() && email.trim() && password.length > 0 && !busy;
  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError('');
    try {
      await login(server, email, password);
      // дальше навигацию переключит корневой layout
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось войти');
      setBusy(false);
    }
  }

  const field = [styles.field, { backgroundColor: c.panel, borderColor: c.border }];
  const input = [styles.input, { color: c.text }];
  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: c.background }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={[
          styles.page,
          { paddingTop: insets.top + 48, paddingBottom: insets.bottom + 24 },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={[styles.logo, { backgroundColor: theme.accent }]}>
          <Feather color="#FFFFFF" size={30} strokeWidth={2} />
        </View>
        <Text style={[styles.title, { color: c.text }]}>SelfNote</Text>
        <Text style={[styles.subtitle, { color: c.secondary }]}>
          Заметки и задачи на вашем сервере
        </Text>

        <View style={[styles.card, { backgroundColor: c.panel }]}>
          <Text style={[styles.label, { color: c.secondary }]}>Адрес сервера</Text>
          <View style={field}>
            <Server color={c.muted} size={20} />
            <TextInput
              style={input}
              value={server}
              onChangeText={setServer}
              placeholder="note.example.ru"
              placeholderTextColor={c.faint}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              textContentType="URL"
              returnKeyType="next"
              onSubmitEditing={() => emailRef.current?.focus()}
              accessibilityLabel="Адрес сервера"
            />
          </View>

          <Text style={[styles.label, { color: c.secondary }]}>Почта</Text>
          <View style={field}>
            <Mail color={c.muted} size={20} />
            <TextInput
              ref={emailRef}
              style={input}
              value={email}
              onChangeText={setEmail}
              placeholder="you@example.ru"
              placeholderTextColor={c.faint}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              textContentType="username"
              autoComplete="email"
              returnKeyType="next"
              onSubmitEditing={() => passwordRef.current?.focus()}
              accessibilityLabel="Почта"
            />
          </View>

          <Text style={[styles.label, { color: c.secondary }]}>Пароль</Text>
          <View style={field}>
            <KeyRound color={c.muted} size={20} />
            <TextInput
              ref={passwordRef}
              style={input}
              value={password}
              onChangeText={setPassword}
              placeholder="Пароль"
              placeholderTextColor={c.faint}
              secureTextEntry={!showPassword}
              textContentType="password"
              autoComplete="current-password"
              returnKeyType="go"
              onSubmitEditing={submit}
              accessibilityLabel="Пароль"
            />
            <Pressable
              onPress={() => setShowPassword((v) => !v)}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel={showPassword ? 'Скрыть пароль' : 'Показать пароль'}
            >
              {showPassword ? <EyeOff color={c.muted} size={20} /> : <Eye color={c.muted} size={20} />}
            </Pressable>
          </View>

          {error ? (
            <Text style={[styles.error, { color: c.danger, backgroundColor: c.dangerBg }]}>
              {error}
            </Text>
          ) : null}

          <Pressable
            onPress={submit}
            disabled={!canSubmit}
            accessibilityRole="button"
            style={({ pressed }) => [
              styles.button,
              { backgroundColor: theme.accent, opacity: !canSubmit ? 0.5 : pressed ? 0.85 : 1 },
            ]}
          >
            {busy ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={styles.buttonText}>Войти</Text>
            )}
          </Pressable>
        </View>

        <Text style={[styles.hint, { color: c.muted }]}>
          Регистрация и восстановление пароля — в веб-версии вашего сервера.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  page: { paddingHorizontal: 20, alignItems: 'stretch', flexGrow: 1 },
  logo: {
    width: 64,
    height: 64,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
  },
  title: {
    fontFamily: fonts.heavy,
    fontSize: 34,
    letterSpacing: -1.2,
    textAlign: 'center',
    marginTop: 18,
  },
  subtitle: { fontFamily: fonts.regular, fontSize: 16, textAlign: 'center', marginTop: 4 },
  card: { marginTop: 32, borderRadius: 24, padding: 18, gap: 8 },
  label: { fontFamily: fonts.semibold, fontSize: 14, marginTop: 6, marginLeft: 4 },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    height: 52,
    borderRadius: 14,
    borderWidth: 1,
    paddingHorizontal: 14,
  },
  input: { flex: 1, fontFamily: fonts.regular, fontSize: 17, height: '100%' },
  error: {
    fontFamily: fonts.medium,
    fontSize: 15,
    lineHeight: 21,
    padding: 12,
    borderRadius: 12,
    marginTop: 8,
    overflow: 'hidden',
  },
  button: {
    height: 54,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 14,
  },
  buttonText: { fontFamily: fonts.semibold, fontSize: 17, color: '#FFFFFF' },
  hint: { fontFamily: fonts.regular, fontSize: 14, textAlign: 'center', marginTop: 20 },
});

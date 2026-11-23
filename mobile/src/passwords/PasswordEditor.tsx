/**
 * Записи хранилища паролей (как PasswordFields в вебе): название, ссылка, логин, пароль.
 * Копирование с очисткой буфера через 30 секунд, генератор, порядок, история (снимки).
 */
import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as Y from 'yjs';
import { ChevronDown, ChevronUp, Copy, CopyPlus, Eye, EyeOff, Lock, Plus, RefreshCw, Trash2 } from 'lucide-react-native';
import { uuid } from '../ids';
import type { Workspace } from '../sync/workspace';
import { savePasswordVersion, type Credential } from '../sync/vault';
import { Card } from '../ui';
import { fonts, useTheme } from '../theme';

function generate() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%&*+-=?';
  let result = '';
  while (result.length < 24) {
    const value = crypto.getRandomValues(new Uint8Array(1))[0];
    if (value < 256 - (256 % alphabet.length)) result += alphabet[value % alphabet.length];
  }
  return result;
}

export function PasswordEditor({ workspace, id, doc }: { workspace: Workspace; id: string; doc: Y.Doc }) {
  const theme = useTheme();
  const { c } = theme;
  const [shown, setShown] = useState<string | null>(null);
  const [toast, setToast] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const entries = doc.getArray<Credential>('credentials');
  const secure = doc.getMap<string>('secure');
  const readOnly = Boolean(workspace.metadata.get(id)?.deletedAt);
  // ревизия полей: при правке с другого устройства перерисовываем неуправляемые поля
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const onRemote = (_e: unknown, transaction: Y.Transaction) => {
      if (!transaction.local) setRevision((r) => r + 1);
    };
    entries.observe(onRemote);
    secure.observe(onRemote);
    return () => {
      entries.unobserve(onRemote);
      secure.unobserve(onRemote);
    };
  }, [entries, secure]);

  useEffect(() => {
    if (readOnly) return;
    savePasswordVersion(doc);
    const timer = setInterval(() => savePasswordVersion(doc), 5 * 60_000);
    return () => {
      clearInterval(timer);
      if (!doc.isDestroyed) savePasswordVersion(doc);
    };
  }, [doc, readOnly]);

  const touch = () => {
    workspace.vault.touch();
    workspace.touch(id);
  };
  function change(index: number, field: keyof Omit<Credential, 'id'>, value: string) {
    const entry = entries.get(index);
    doc.transact(() => {
      entries.delete(index, 1);
      entries.insert(index, [{ ...entry, [field]: value }]);
    });
    touch();
  }
  function move(index: number, delta: number) {
    const entry = entries.get(index);
    doc.transact(() => {
      entries.delete(index, 1);
      entries.insert(index + delta, [entry]);
    });
    touch();
  }
  function flash(message: string) {
    setToast(message);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 1800);
  }
  async function copy(value: string, what: string) {
    if (!value) return;
    workspace.vault.touch();
    await Clipboard.setStringAsync(value);
    flash(`${what} скопирован — буфер очистится через 30 секунд`);
    setTimeout(() => {
      void Clipboard.getStringAsync()
        .then((current) => (current === value ? Clipboard.setStringAsync('') : undefined))
        .catch(() => undefined);
    }, 30_000);
  }

  const field = (label: string, value: string, onChange: (v: string) => void, extra?: React.ReactNode, secret = false, entryId = '') => (
    <View style={styles.fieldWrap}>
      <Text style={[styles.label, { color: c.secondary }]}>{label}</Text>
      <View style={[styles.field, { borderColor: c.border, backgroundColor: c.background }]}>
        <TextInput
          key={`${entryId}-${label}-${revision}`}
          defaultValue={value}
          onChangeText={onChange}
          editable={!readOnly}
          secureTextEntry={secret}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          textContentType="none"
          style={[styles.input, { color: c.text }]}
          accessibilityLabel={label}
        />
        {extra}
      </View>
    </View>
  );
  const icon = (label: string, node: React.ReactNode, onPress: () => void, disabled = false) => (
    <Pressable
      onPress={onPress}
      disabled={disabled || readOnly}
      hitSlop={4}
      style={[styles.icon, (disabled || readOnly) && { opacity: 0.3 }]}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      {node}
    </Pressable>
  );

  const list = entries.toArray();
  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={100}>
      <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled" onScrollBeginDrag={() => workspace.vault.touch()}>
        <View style={styles.head}>
          <TextInput
            key={`title-${revision}`}
            defaultValue={secure.get('title') || ''}
            onChangeText={(v) => {
              secure.set('title', v);
              touch();
            }}
            editable={!readOnly}
            placeholder="Название, например «Домашний сервер»"
            placeholderTextColor={c.faint}
            style={[styles.title, { color: c.text }]}
            multiline
            accessibilityLabel="Название"
          />
          <Pressable
            onPress={workspace.vault.lock}
            style={[styles.lock, { backgroundColor: c.soft }]}
            accessibilityRole="button"
          >
            <Lock color={c.text} size={16} />
            <Text style={[styles.lockText, { color: c.text }]}>Закрыть</Text>
          </Pressable>
        </View>

        {list.map((entry, index) => (
          <Card key={entry.id} style={styles.card}>
            {field('Название записи', entry.name, (v) => change(index, 'name', v), null, false, entry.id)}
            {field('Ссылка или адрес', entry.url, (v) => change(index, 'url', v), null, false, entry.id)}
            {field(
              'Логин',
              entry.login,
              (v) => change(index, 'login', v),
              icon('Копировать логин', <Copy color={c.secondary} size={19} />, () => void copy(entry.login, 'Логин')),
              false,
              entry.id,
            )}
            {field(
              'Пароль',
              entry.password,
              (v) => change(index, 'password', v),
              <>
                {icon(
                  shown === entry.id ? 'Скрыть пароль' : 'Показать пароль',
                  shown === entry.id ? <EyeOff color={c.secondary} size={19} /> : <Eye color={c.secondary} size={19} />,
                  () => setShown(shown === entry.id ? null : entry.id),
                )}
                {icon('Копировать пароль', <Copy color={c.secondary} size={19} />, () => void copy(entry.password, 'Пароль'))}
                {icon('Сгенерировать пароль', <RefreshCw color={c.secondary} size={19} />, () => {
                  const replace = () => {
                    savePasswordVersion(doc);
                    change(index, 'password', generate());
                    setShown(entry.id);
                    setRevision((r) => r + 1);
                  };
                  if (!entry.password) return replace();
                  Alert.alert('Заменить пароль новым?', 'Старый сохранится в истории.', [
                    { text: 'Отмена', style: 'cancel' },
                    { text: 'Заменить', onPress: replace },
                  ]);
                })}
              </>,
              shown !== entry.id,
              entry.id,
            )}
            <View style={styles.actions}>
              {icon('Выше', <ChevronUp color={c.text} size={20} />, () => move(index, -1), index === 0)}
              {icon('Ниже', <ChevronDown color={c.text} size={20} />, () => move(index, 1), index === list.length - 1)}
              {icon('Дублировать', <CopyPlus color={c.text} size={19} />, () => {
                entries.insert(index + 1, [{ ...entry, id: uuid() }]);
                touch();
              })}
              <View style={{ flex: 1 }} />
              {icon('Удалить запись', <Trash2 color={c.danger} size={19} />, () =>
                Alert.alert('Удалить запись?', 'Она останется в зашифрованной истории.', [
                  { text: 'Отмена', style: 'cancel' },
                  {
                    text: 'Удалить',
                    style: 'destructive',
                    onPress: () => {
                      savePasswordVersion(doc);
                      entries.delete(index, 1);
                      touch();
                    },
                  },
                ]),
              )}
            </View>
          </Card>
        ))}
        {!readOnly ? (
          <Pressable
            onPress={() => {
              entries.push([{ id: uuid(), name: '', url: '', login: '', password: '' }]);
              touch();
            }}
            style={({ pressed }) => [styles.add, { borderColor: c.border }, pressed && { backgroundColor: c.soft }]}
            accessibilityRole="button"
          >
            <Plus color={theme.accentText} size={20} />
            <Text style={[styles.addText, { color: theme.accentText }]}>Добавить запись</Text>
          </Pressable>
        ) : null}
      </ScrollView>
      {toast ? (
        <View style={[styles.toast, { backgroundColor: c.strong }]} pointerEvents="none">
          <Text style={[styles.toastText, { color: c.onStrong }]}>{toast}</Text>
        </View>
      ) : null}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, paddingBottom: 60, gap: 14 },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingHorizontal: 6 },
  title: { flex: 1, fontFamily: fonts.heavy, fontSize: 28, letterSpacing: -0.9, padding: 0 },
  lock: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 36, paddingHorizontal: 12, borderRadius: 999, marginTop: 2 },
  lockText: { fontFamily: fonts.semibold, fontSize: 14 },
  card: { padding: 14, gap: 10 },
  fieldWrap: { gap: 4 },
  label: { fontFamily: fonts.medium, fontSize: 13, marginLeft: 4 },
  field: { flexDirection: 'row', alignItems: 'center', minHeight: 48, borderWidth: 1, borderRadius: 12, paddingLeft: 12, paddingRight: 2 },
  input: { flex: 1, fontFamily: fonts.regular, fontSize: 16, paddingVertical: 10 },
  icon: { width: 40, height: 44, alignItems: 'center', justifyContent: 'center' },
  actions: { flexDirection: 'row', alignItems: 'center', marginTop: -2 },
  add: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 52, borderWidth: 1, borderStyle: 'dashed', borderRadius: 16 },
  addText: { fontFamily: fonts.semibold, fontSize: 16 },
  toast: { position: 'absolute', left: 20, right: 20, bottom: 30, borderRadius: 14, padding: 12 },
  toastText: { fontFamily: fonts.medium, fontSize: 14, textAlign: 'center' },
});

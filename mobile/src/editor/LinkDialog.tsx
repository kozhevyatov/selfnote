import { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { fonts, useTheme } from '../theme';

/** Вставка и правка ссылки (Alert.prompt есть только на iOS). */
export function LinkDialog({
  visible,
  initial,
  onClose,
  onSubmit,
}: {
  visible: boolean;
  initial: string | null;
  onClose: () => void;
  onSubmit: (href: string | null) => void;
}) {
  const theme = useTheme();
  const { c } = theme;
  const [value, setValue] = useState('');
  useEffect(() => {
    if (visible) setValue(initial ?? '');
  }, [visible, initial]);
  const submit = () => {
    const href = value.trim();
    if (!href) return onSubmit(null);
    onSubmit(/^[a-z][a-z0-9+.-]*:/i.test(href) ? href : `https://${href}`);
  };
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.overlay} onPress={onClose} accessibilityLabel="Закрыть">
        <Pressable style={[styles.dialog, { backgroundColor: c.panel }]} onPress={() => undefined}>
          <Text style={[styles.title, { color: c.text }]}>Ссылка</Text>
          <TextInput
            value={value}
            onChangeText={setValue}
            autoFocus
            placeholder="https://"
            placeholderTextColor={c.faint}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="done"
            onSubmitEditing={submit}
            style={[styles.input, { color: c.text, borderColor: c.border, backgroundColor: c.background }]}
            accessibilityLabel="Адрес ссылки"
          />
          <View style={styles.actions}>
            {initial ? (
              <Pressable onPress={() => onSubmit(null)} style={styles.action} accessibilityRole="button">
                <Text style={[styles.actionText, { color: c.danger }]}>Убрать</Text>
              </Pressable>
            ) : null}
            <View style={{ flex: 1 }} />
            <Pressable onPress={onClose} style={styles.action} accessibilityRole="button">
              <Text style={[styles.actionText, { color: c.secondary }]}>Отмена</Text>
            </Pressable>
            <Pressable onPress={submit} style={styles.action} accessibilityRole="button">
              <Text style={[styles.actionText, { color: theme.accentText }]}>Готово</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: '#00000066', justifyContent: 'center', padding: 24 },
  dialog: { borderRadius: 22, padding: 18, gap: 12 },
  title: { fontFamily: fonts.bold, fontSize: 18 },
  input: { height: 48, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, fontFamily: fonts.regular, fontSize: 16 },
  actions: { flexDirection: 'row', alignItems: 'center' },
  action: { paddingHorizontal: 12, height: 44, justifyContent: 'center' },
  actionText: { fontFamily: fonts.semibold, fontSize: 16 },
});

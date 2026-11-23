/**
 * Меню заметки: закрепить, избранное, перенести, в корзину. Открывается кнопкой «⋯»
 * на экране заметки и долгим нажатием на строку списка. Только для своих заметок.
 */
import { useEffect, useState } from 'react';
import { Alert, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Check, ChevronLeft, FolderInput, Hash, Pin, PinOff, Plus, Star, StarOff, Trash2 } from 'lucide-react-native';
import { useWorkspace } from './session';
import { fonts, useTheme } from './theme';

export function NoteMenu({
  id,
  onClose,
  onTrashed,
}: {
  id: string | null;
  onClose: () => void;
  onTrashed?: () => void;
}) {
  const theme = useTheme();
  const { c } = theme;
  const insets = useSafeAreaInsets();
  const workspace = useWorkspace();
  const [mode, setMode] = useState<'main' | 'move' | 'tags'>('main');
  const [newTag, setNewTag] = useState('');
  useEffect(() => {
    if (id) {
      setMode('main');
      setNewTag('');
    }
  }, [id]);
  const note = id ? workspace.metadata.get(id) : undefined;
  if (!id || !note || !workspace.isOwner(id)) return null;

  const act = (fn: () => void) => () => {
    fn();
    onClose();
  };
  const trash = () =>
    Alert.alert('Убрать заметку в корзину?', 'Её можно восстановить в веб-версии в течение 30 дней.', [
      { text: 'Отмена', style: 'cancel' },
      {
        text: 'В корзину',
        style: 'destructive',
        onPress: () => {
          workspace.update(id, { deletedAt: new Date().toISOString() });
          onClose();
          onTrashed?.();
        },
      },
    ]);
  const move = (notebookId: string | null, sectionId: string | null) =>
    act(() => workspace.update(id, { notebookId, sectionId }))();

  const row = (
    label: string,
    icon: React.ReactNode,
    onPress: () => void,
    options: { danger?: boolean; checked?: boolean; indent?: boolean } = {},
  ) => (
    <Pressable
      key={label + (options.indent ? '-s' : '')}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: options.checked }}
      style={({ pressed }) => [
        styles.row,
        options.indent && { paddingLeft: 52 },
        pressed && { backgroundColor: c.soft },
      ]}
    >
      {icon}
      <Text
        style={[styles.label, { color: options.danger ? c.danger : c.text }, options.indent && styles.sub]}
        numberOfLines={1}
      >
        {label}
      </Text>
      {options.checked ? <Check color={theme.accentText} size={20} /> : null}
    </Pressable>
  );

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Pressable style={styles.overlay} onPress={onClose} accessibilityLabel="Закрыть меню" />
      <View style={[styles.sheet, { backgroundColor: c.panel, paddingBottom: insets.bottom + 10 }]}>
        <View style={[styles.handle, { backgroundColor: c.border }]} />
        {mode === 'main' ? (
          <>
            <Text style={[styles.title, { color: c.secondary }]} numberOfLines={1}>
              {note.title || 'Без названия'}
            </Text>
            {row(
              note.pinned ? 'Открепить' : 'Закрепить',
              note.pinned ? <PinOff color={c.text} size={21} /> : <Pin color={c.text} size={21} />,
              act(() => workspace.update(id, { pinned: !note.pinned })),
            )}
            {row(
              note.favorite ? 'Убрать из избранного' : 'В избранное',
              note.favorite ? <StarOff color={c.text} size={21} /> : <Star color={c.text} size={21} />,
              act(() => workspace.update(id, { favorite: !note.favorite })),
            )}
            {row('Перенести в книжку', <FolderInput color={c.text} size={21} />, () => setMode('move'))}
            {row(
              note.tags?.length ? `Метки: ${note.tags.map((t) => `#${t}`).join(' ')}` : 'Метки',
              <Hash color={c.text} size={21} />,
              () => setMode('tags'),
            )}
            <View style={[styles.divider, { backgroundColor: c.line }]} />
            {row('В корзину', <Trash2 color={c.danger} size={21} />, trash, { danger: true })}
          </>
        ) : mode === 'tags' ? (
          <>
            <Pressable onPress={() => setMode('main')} style={styles.back} accessibilityRole="button">
              <ChevronLeft color={theme.accentText} size={22} />
              <Text style={[styles.backText, { color: theme.accentText }]}>Метки</Text>
            </Pressable>
            <ScrollView style={{ maxHeight: 360 }} keyboardShouldPersistTaps="handled">
              {workspace.tags().map((tag) => {
                const on = Boolean(note.tags?.includes(tag));
                return row(
                  `#${tag}`,
                  null,
                  () =>
                    workspace.update(id, {
                      tags: on ? note.tags.filter((t) => t !== tag) : [...(note.tags ?? []), tag],
                    }),
                  { checked: on },
                );
              })}
            </ScrollView>
            <View style={[styles.newTag, { borderColor: c.border }]}>
              <Plus color={c.muted} size={20} />
              <TextInput
                value={newTag}
                onChangeText={setNewTag}
                placeholder="Новая метка"
                placeholderTextColor={c.faint}
                autoCapitalize="none"
                returnKeyType="done"
                onSubmitEditing={() => {
                  const tag = workspace.addTag(newTag);
                  if (tag && !note.tags?.includes(tag))
                    workspace.update(id, { tags: [...(note.tags ?? []), tag] });
                  setNewTag('');
                }}
                style={[styles.newTagInput, { color: c.text }]}
                accessibilityLabel="Новая метка"
              />
            </View>
          </>
        ) : (
          <>
            <Pressable onPress={() => setMode('main')} style={styles.back} accessibilityRole="button">
              <ChevronLeft color={theme.accentText} size={22} />
              <Text style={[styles.backText, { color: theme.accentText }]}>Перенести в книжку</Text>
            </Pressable>
            <ScrollView style={{ maxHeight: 420 }}>
              {row('Без книжки', <View style={[styles.swatch, { backgroundColor: c.faint }]} />, () => move(null, null), {
                checked: !note.notebookId,
              })}
              {workspace.notebooks().map((nb) => [
                row(
                  nb.name,
                  <View style={[styles.swatch, { backgroundColor: nb.color || theme.accent }]} />,
                  () => move(nb.id, null),
                  { checked: note.notebookId === nb.id && !note.sectionId },
                ),
                ...workspace.sections(nb.id).map((s) =>
                  row(s.name, null, () => move(nb.id, s.id), {
                    indent: true,
                    checked: note.sectionId === s.id,
                  }),
                ),
              ])}
            </ScrollView>
          </>
        )}
      </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: '#00000055' },
  sheet: { borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingTop: 8, paddingHorizontal: 8 },
  handle: { alignSelf: 'center', width: 40, height: 5, borderRadius: 3, marginBottom: 8 },
  title: { fontFamily: fonts.semibold, fontSize: 14, paddingHorizontal: 14, paddingBottom: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 52, paddingHorizontal: 14, borderRadius: 14 },
  label: { flex: 1, fontFamily: fonts.medium, fontSize: 17 },
  sub: { fontFamily: fonts.regular, fontSize: 16 },
  divider: { height: 1, marginVertical: 6, marginHorizontal: 14 },
  swatch: { width: 14, height: 14, borderRadius: 4, marginHorizontal: 3.5 },
  back: { flexDirection: 'row', alignItems: 'center', gap: 4, height: 48, paddingHorizontal: 8 },
  backText: { fontFamily: fonts.semibold, fontSize: 17 },
  newTag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    height: 50,
    marginHorizontal: 6,
    marginTop: 6,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderRadius: 14,
  },
  newTagInput: { flex: 1, fontFamily: fonts.regular, fontSize: 16, height: '100%' },
});

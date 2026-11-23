import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { Check, CloudOff, Lock, Users } from 'lucide-react-native';
import type { Note } from '@selfnote/shared';
import { dueLabel, shortTime } from './dates';
import { fonts, mix, useTheme } from './theme';
import type { Workspace } from './sync/workspace';

/** Квадратный чекбокс как в вебе (у RN своего нет). */
export function Checkbox({
  checked,
  onChange,
  label,
  size = 22,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  size?: number;
  disabled?: boolean;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={() => onChange(!checked)}
      disabled={disabled}
      hitSlop={12}
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled }}
      accessibilityLabel={label}
      style={{
        width: size,
        height: size,
        borderRadius: 6,
        borderWidth: checked ? 0 : 2,
        borderColor: theme.c.faint,
        backgroundColor: checked ? theme.accent : 'transparent',
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {checked ? <Check color="#FFFFFF" size={size - 6} strokeWidth={3} /> : null}
    </Pressable>
  );
}

/** Плашка срока задачи: сегодня — акцент, просрочено — красная, остальное — серая. */
export function DueBadge({ due }: { due: string }) {
  const theme = useTheme();
  const { text, overdue, today } = dueLabel(due);
  const [color, background] = overdue
    ? [theme.c.danger, theme.c.dangerBg]
    : today
      ? [theme.accentText, theme.tint]
      : [theme.c.secondary, theme.c.soft];
  return (
    <Text style={[styles.badge, { color, backgroundColor: background }]}>
      {overdue ? `Просрочено · ${text}` : text}
    </Text>
  );
}

export function Card({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const { c, isDark } = useTheme();
  return (
    <View
      style={[
        styles.card,
        { backgroundColor: c.panel, borderColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(20,20,20,0.05)' },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function SectionTitle({ title, hint, icon }: { title: string; hint?: string; icon?: React.ReactNode }) {
  const { c } = useTheme();
  return (
    <View style={styles.sectionTitle}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        {icon}
        <Text style={[styles.sectionText, { color: c.secondary }]} accessibilityRole="header">
          {title}
        </Text>
      </View>
      {hint ? <Text style={[styles.sectionHint, { color: c.secondary }]}>{hint}</Text> : null}
    </View>
  );
}

/** Строка заметки в списке. */
export function NoteRow({
  note,
  workspace,
  onPress,
  first,
}: {
  note: Note;
  workspace: Workspace;
  onPress: () => void;
  first: boolean;
}) {
  const theme = useTheme();
  const { c } = theme;
  const title = note.encrypted && note.hideTitle ? 'Заметка под паролем' : note.title || 'Без названия';
  const preview = note.encrypted
    ? 'Защищена паролем'
    : workspace.extract(note.id).plainText.replace(/\s+/g, ' ').trim() ||
      (workspace.isLoaded(note.id) ? 'Пустая заметка' : ' ');
  const notebook = workspace.notebook(note.notebookId);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${preview}`}
      style={({ pressed }) => [
        styles.row,
        !first && { borderTopWidth: StyleSheet.hairlineWidth * 2, borderTopColor: c.line },
        pressed && { backgroundColor: theme.selection },
      ]}
    >
      <View style={styles.rowHead}>
        <Text style={[styles.rowTitle, { color: c.text }]} numberOfLines={1}>
          {title}
        </Text>
        <View style={styles.rowMeta}>
          {workspace.isCollaborative(note.id) ? <Users color={c.muted} size={14} /> : null}
          {note.encrypted ? <Lock color={c.muted} size={14} /> : null}
          <Text style={[styles.rowTime, { color: c.secondary }]}>{shortTime(note.updatedAt)}</Text>
        </View>
      </View>
      <View style={styles.rowFoot}>
        <Text
          style={[
            styles.rowPreview,
            { color: note.encrypted ? c.muted : c.secondary },
            note.encrypted && { fontFamily: fonts.regular, fontStyle: 'italic' },
          ]}
          numberOfLines={1}
        >
          {preview}
        </Text>
        {notebook ? (
          <View style={[styles.dot, { backgroundColor: notebook.color || theme.accent }]} />
        ) : null}
      </View>
    </Pressable>
  );
}

/** Полоска «нет связи» — данные при этом остаются доступны. */
export function OfflineBanner({ workspace }: { workspace: Workspace }) {
  const { c } = useTheme();
  if (workspace.connection !== 'offline') return null;
  return (
    <View style={[styles.offline, { backgroundColor: mix(c.secondary, 0.12, c.background) }]}>
      <CloudOff color={c.secondary} size={16} />
      <Text style={[styles.offlineText, { color: c.secondary }]}>
        Нет связи с сервером — правки сохранятся на телефоне
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    fontFamily: fonts.semibold,
    fontSize: 13,
    paddingHorizontal: 9,
    paddingVertical: 3,
    borderRadius: 999,
    overflow: 'hidden',
  },
  card: { borderRadius: 20, borderWidth: 1, overflow: 'hidden' },
  sectionTitle: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 6,
    marginBottom: 8,
  },
  sectionText: { fontFamily: fonts.semibold, fontSize: 14 },
  sectionHint: { fontFamily: fonts.medium, fontSize: 14 },
  row: { paddingHorizontal: 16, paddingVertical: 13 },
  rowHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10 },
  rowTitle: { fontFamily: fonts.semibold, fontSize: 17, flex: 1 },
  rowMeta: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rowTime: { fontFamily: fonts.regular, fontSize: 13 },
  rowFoot: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 3 },
  rowPreview: { fontFamily: fonts.regular, fontSize: 15, flex: 1 },
  dot: { width: 8, height: 8, borderRadius: 3 },
  offline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginBottom: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 12,
  },
  offlineText: { fontFamily: fonts.medium, fontSize: 14, flex: 1 },
});

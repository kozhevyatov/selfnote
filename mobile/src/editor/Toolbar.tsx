import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import {
  Bold,
  ChevronDown,
  EyeOff,
  Heading2,
  Heading3,
  Italic,
  Link,
  List,
  ListOrdered,
  ListTodo,
  Redo2,
  Strikethrough,
  Undo2,
} from 'lucide-react-native';
import type { EditorActive, EditorCommand } from '@selfnote/shared';
import { useTheme } from '../theme';

type Item = { command: EditorCommand | 'link'; label: string; Icon: typeof Bold } | 'divider';
const ITEMS: Item[] = [
  { command: 'bold', label: 'Жирный', Icon: Bold },
  { command: 'italic', label: 'Курсив', Icon: Italic },
  { command: 'strike', label: 'Зачёркнутый', Icon: Strikethrough },
  { command: 'spoiler', label: 'Скрытый текст', Icon: EyeOff },
  'divider',
  { command: 'taskList', label: 'Список задач', Icon: ListTodo },
  { command: 'bulletList', label: 'Маркированный список', Icon: List },
  { command: 'orderedList', label: 'Нумерованный список', Icon: ListOrdered },
  { command: 'heading2', label: 'Заголовок', Icon: Heading2 },
  { command: 'heading3', label: 'Подзаголовок', Icon: Heading3 },
  { command: 'link', label: 'Ссылка', Icon: Link },
  'divider',
  { command: 'undo', label: 'Отменить', Icon: Undo2 },
  { command: 'redo', label: 'Повторить', Icon: Redo2 },
];

/** Панель форматирования над клавиатурой. В заголовке доступно только «Скрыть клавиатуру». */
export function Toolbar({
  area,
  active,
  onCommand,
  onLink,
}: {
  area: 'title' | 'body';
  active: EditorActive;
  onCommand: (command: EditorCommand) => void;
  onLink: () => void;
}) {
  const theme = useTheme();
  const { c } = theme;
  const inBody = area === 'body';
  return (
    <View
      style={[styles.bar, { backgroundColor: c.panel, borderTopColor: c.line }]}
      accessibilityRole="toolbar"
      accessibilityLabel="Форматирование"
    >
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="always"
        contentContainerStyle={styles.items}
        style={{ flex: 1 }}
      >
        {ITEMS.map((item, index) => {
          if (item === 'divider')
            return <View key={index} style={[styles.divider, { backgroundColor: c.line }]} />;
          const { command, label, Icon } = item;
          const on = Boolean(active[command]);
          const disabled =
            !inBody || ((command === 'undo' || command === 'redo') && active[command] === false);
          return (
            <Pressable
              key={command}
              disabled={disabled}
              onPress={() => (command === 'link' ? onLink() : onCommand(command))}
              accessibilityRole="button"
              accessibilityLabel={label}
              accessibilityState={{ selected: on, disabled }}
              style={({ pressed }) => [
                styles.button,
                on && { backgroundColor: theme.tint },
                pressed && { backgroundColor: c.soft },
                disabled && { opacity: 0.35 },
              ]}
            >
              <Icon color={on ? theme.accentText : c.text} size={21} strokeWidth={2.1} />
            </Pressable>
          );
        })}
      </ScrollView>
      <Pressable
        onPress={() => onCommand('blur')}
        accessibilityRole="button"
        accessibilityLabel="Скрыть клавиатуру"
        style={({ pressed }) => [
          styles.button,
          styles.done,
          { borderLeftColor: c.line },
          pressed && { backgroundColor: c.soft },
        ]}
      >
        <ChevronDown color={c.text} size={22} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', height: 50, borderTopWidth: 1 },
  items: { alignItems: 'center', paddingHorizontal: 6, gap: 2 },
  button: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  divider: { width: 1, height: 24, marginHorizontal: 4 },
  done: { borderLeftWidth: 1, borderRadius: 0, width: 52 },
});

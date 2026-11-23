/**
 * Просмотр содержимого заметки прямо из Y.XmlFragment (тот же формат, что пишет
 * TipTap в вебе). Временный шаг до редактора 10tap: текст только читается,
 * а задачи можно отмечать.
 */
import { useState } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';
import { ImageIcon } from 'lucide-react-native';
import * as Y from 'yjs';
import { Checkbox, DueBadge } from './ui';
import { fonts, useTheme, type Theme } from './theme';

type Delta = { insert: unknown; attributes?: Record<string, unknown> }[];

function Spoiler({ text, theme }: { text: string; theme: Theme }) {
  const [open, setOpen] = useState(false);
  if (open) return <Text onPress={() => setOpen(false)}>{text}</Text>;
  return (
    <Text
      onPress={() => setOpen(true)}
      accessibilityRole="button"
      accessibilityLabel="Скрытый текст, нажмите, чтобы показать"
      style={{ backgroundColor: theme.c.strong, color: theme.c.strong }}
    >
      {text}
    </Text>
  );
}

function Inline({ node, theme, muted }: { node: Y.XmlElement; theme: Theme; muted?: boolean }) {
  const parts: React.ReactNode[] = [];
  node.toArray().forEach((child, index) => {
    if (child instanceof Y.XmlText) {
      (child.toDelta() as Delta).forEach((part, i) => {
        if (typeof part.insert !== 'string') return;
        const a = part.attributes ?? {};
        const key = `${index}-${i}`;
        const style = [
          a.bold && { fontFamily: fonts.bold },
          a.italic && { fontStyle: 'italic' as const },
          a.strike && { textDecorationLine: 'line-through' as const, color: theme.c.muted },
          a.code && { fontFamily: 'Menlo', backgroundColor: theme.c.soft },
        ];
        if (a.spoiler) parts.push(<Spoiler key={key} text={part.insert} theme={theme} />);
        else if (a.link) {
          const href = String((a.link as { href?: string }).href ?? '');
          parts.push(
            <Text
              key={key}
              style={[style, { color: theme.accentText, textDecorationLine: 'underline' }]}
              onPress={() => /^https?:\/\//i.test(href) && void Linking.openURL(href)}
              accessibilityRole="link"
            >
              {part.insert}
            </Text>,
          );
        } else parts.push(<Text key={key} style={style}>{part.insert}</Text>);
      });
    } else if (child instanceof Y.XmlElement && child.nodeName === 'hardBreak') parts.push('\n');
  });
  return <Text style={muted && { color: theme.c.faint, textDecorationLine: 'line-through' }}>{parts}</Text>;
}

function Blocks({
  nodes,
  theme,
  onTask,
  canEdit,
  depth = 0,
}: {
  nodes: (Y.XmlElement | Y.XmlText | Y.XmlHook)[];
  theme: Theme;
  onTask: (id: string, checked: boolean) => void;
  canEdit: boolean;
  depth?: number;
}) {
  const { c } = theme;
  return (
    <>
      {nodes.map((node, index) => {
        if (!(node instanceof Y.XmlElement)) return null;
        const key = String(index);
        switch (node.nodeName) {
          case 'paragraph':
            return (
              <Text key={key} style={[styles.p, { color: c.text }]}>
                <Inline node={node} theme={theme} />
              </Text>
            );
          case 'heading': {
            const level = Number(node.getAttribute('level')) || 2;
            return (
              <Text
                key={key}
                accessibilityRole="header"
                style={[styles.h, { color: c.text, fontSize: level === 1 ? 26 : level === 2 ? 21 : 18 }]}
              >
                <Inline node={node} theme={theme} />
              </Text>
            );
          }
          case 'bulletList':
          case 'orderedList':
            return (
              <View key={key} style={styles.list}>
                {node.toArray().map((item, i) =>
                  item instanceof Y.XmlElement ? (
                    <View key={i} style={styles.li}>
                      <Text style={[styles.bullet, { color: c.secondary }]}>
                        {node.nodeName === 'orderedList' ? `${i + 1}.` : '•'}
                      </Text>
                      <View style={{ flex: 1 }}>
                        <Blocks nodes={item.toArray()} theme={theme} onTask={onTask} canEdit={canEdit} depth={depth + 1} />
                      </View>
                    </View>
                  ) : null,
                )}
              </View>
            );
          case 'taskList':
            return (
              <View key={key} style={{ marginBottom: 10 }}>
                {node.toArray().map((item, i) => {
                  if (!(item instanceof Y.XmlElement)) return null;
                  const attrs = item.getAttributes() as Record<string, unknown>;
                  const checked = attrs.checked === true || attrs.checked === 'true';
                  const id = typeof attrs.id === 'string' ? attrs.id : '';
                  const due = typeof attrs.due === 'string' && attrs.due ? attrs.due : null;
                  const [first, ...rest] = item.toArray();
                  return (
                    <View key={i}>
                      <View style={[styles.task, i > 0 && { borderTopWidth: 1, borderTopColor: c.line }]}>
                        <Checkbox
                          checked={checked}
                          label={checked ? 'Задача выполнена' : 'Задача'}
                          disabled={!canEdit || !id}
                          onChange={(v) => onTask(id, v)}
                        />
                        <Text style={[styles.taskText, { color: c.text }]}>
                          {first instanceof Y.XmlElement ? (
                            <Inline node={first} theme={theme} muted={checked} />
                          ) : null}
                        </Text>
                        {due && !checked ? <DueBadge due={due} /> : null}
                      </View>
                      {rest.length ? (
                        <View style={{ paddingLeft: 34 }}>
                          <Blocks nodes={rest} theme={theme} onTask={onTask} canEdit={canEdit} depth={depth + 1} />
                        </View>
                      ) : null}
                    </View>
                  );
                })}
              </View>
            );
          case 'blockquote':
            return (
              <View key={key} style={[styles.quote, { borderLeftColor: c.border }]}>
                <Blocks nodes={node.toArray()} theme={theme} onTask={onTask} canEdit={canEdit} depth={depth + 1} />
              </View>
            );
          case 'codeBlock':
            return (
              <Text key={key} style={[styles.code, { backgroundColor: c.soft, color: c.text }]}>
                {node.toArray().map((t) => (t instanceof Y.XmlText ? t.toString() : '')).join('')}
              </Text>
            );
          case 'image':
            return (
              <View key={key} style={[styles.image, { backgroundColor: c.soft }]}>
                <ImageIcon color={c.muted} size={22} />
                <Text style={[styles.imageText, { color: c.muted }]}>Картинка — появится вместе с редактором</Text>
              </View>
            );
          case 'horizontalRule':
            return <View key={key} style={[styles.hr, { backgroundColor: c.line }]} />;
          default:
            return (
              <Blocks key={key} nodes={node.toArray()} theme={theme} onTask={onTask} canEdit={canEdit} depth={depth + 1} />
            );
        }
      })}
    </>
  );
}

export function NoteView({
  doc,
  onTask,
  canEdit,
}: {
  doc: Y.Doc;
  onTask: (id: string, checked: boolean) => void;
  canEdit: boolean;
}) {
  const theme = useTheme();
  const nodes = doc.getXmlFragment('content').toArray();
  return <Blocks nodes={nodes} theme={theme} onTask={onTask} canEdit={canEdit} />;
}

const styles = StyleSheet.create({
  p: { fontFamily: fonts.regular, fontSize: 17, lineHeight: 26, marginBottom: 12 },
  h: { fontFamily: fonts.bold, letterSpacing: -0.4, marginTop: 8, marginBottom: 8 },
  list: { marginBottom: 6 },
  li: { flexDirection: 'row', gap: 8 },
  bullet: { fontFamily: fonts.medium, fontSize: 17, lineHeight: 26, minWidth: 16 },
  task: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 50, paddingVertical: 8 },
  taskText: { flex: 1, fontFamily: fonts.regular, fontSize: 17, lineHeight: 24 },
  quote: { borderLeftWidth: 3, paddingLeft: 12, marginBottom: 12 },
  code: { fontFamily: 'Menlo', fontSize: 14, padding: 12, borderRadius: 10, marginBottom: 12, overflow: 'hidden' },
  image: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 14,
    borderRadius: 14,
    marginBottom: 12,
  },
  imageText: { fontFamily: fonts.medium, fontSize: 14, flex: 1 },
  hr: { height: 1, marginVertical: 14 },
});

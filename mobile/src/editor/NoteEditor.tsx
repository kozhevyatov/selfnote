/**
 * Редактор заметки: TipTap в WebView (apps/web/src/mobile-editor) + родная панель
 * форматирования над клавиатурой. Документ — копия Y.Doc заметки: изменения ходят
 * в обе стороны, сеть и офлайн-хранилище остаются на стороне приложения.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { KeyboardAvoidingView, Linking, Platform, StyleSheet, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import * as Y from 'yjs';
import {
  fromBase64,
  toBase64,
  type EditorActive,
  type EditorCommand,
  type EditorTheme,
  type FromEditor,
  type ToEditor,
} from '@selfnote/shared';
import type { Workspace } from '../sync/workspace';
import { useTheme, type Theme } from '../theme';
import editorHtml from './editorHtml';
import { LinkDialog } from './LinkDialog';
import { Toolbar } from './Toolbar';

const FROM_EDITOR = Symbol('editor');

function editorTheme(theme: Theme): EditorTheme {
  const { c } = theme;
  return {
    dark: theme.isDark,
    colors: {
      background: c.panel,
      text: c.text,
      secondary: c.secondary,
      muted: c.muted,
      faint: c.faint,
      line: c.line,
      soft: c.soft,
      accent: theme.accent,
      'accent-text': theme.accentText,
      tint: theme.tint,
      danger: c.danger,
      'danger-bg': c.dangerBg,
      strong: c.strong,
    },
  };
}

export const editorAvailable = editorHtml.length > 0;

export function NoteEditor({
  workspace,
  id,
  doc,
  focusTitle,
}: {
  workspace: Workspace;
  id: string;
  doc: Y.Doc;
  focusTitle: boolean;
}) {
  const theme = useTheme();
  const webview = useRef<WebView>(null);
  const ready = useRef(false);
  const [focus, setFocus] = useState<'title' | 'body' | null>(null);
  const [active, setActive] = useState<EditorActive>({});
  const [link, setLink] = useState<string | null>(null);
  const [linkDialog, setLinkDialog] = useState(false);
  const note = workspace.metadata.get(id);
  const title = note?.title ?? '';
  const editable = workspace.canEdit(id);
  const themeKey = JSON.stringify(editorTheme(theme));

  const send = useCallback((message: ToEditor) => {
    if (!ready.current) return;
    webview.current?.injectJavaScript(
      `window.__selfnote && window.__selfnote(${JSON.stringify(message)});true;`,
    );
  }, []);

  // Изменения из сети и с других экранов (отметка задачи на главной) — в редактор.
  useEffect(() => {
    const forward = (update: Uint8Array, origin: unknown) => {
      if (origin !== FROM_EDITOR) send({ type: 'update', update: toBase64(update) });
    };
    doc.on('update', forward);
    return () => doc.off('update', forward);
  }, [doc, send]);
  useEffect(() => send({ type: 'title', title }), [title, send]);
  useEffect(() => send({ type: 'editable', editable }), [editable, send]);
  useEffect(() => send({ type: 'theme', theme: JSON.parse(themeKey) }), [themeKey, send]);

  const initial = useMemo(() => ({ title, focusTitle }), []); // eslint-disable-line react-hooks/exhaustive-deps
  const onMessage = (event: WebViewMessageEvent) => {
    let message: FromEditor;
    try {
      message = JSON.parse(event.nativeEvent.data);
    } catch {
      return;
    }
    switch (message.type) {
      case 'ready':
        ready.current = true;
        send({
          type: 'init',
          state: toBase64(Y.encodeStateAsUpdate(doc)),
          title: workspace.metadata.get(id)?.title ?? initial.title,
          titlePlaceholder: 'Без названия',
          editable,
          theme: editorTheme(theme),
          focusTitle: initial.focusTitle,
        });
        break;
      case 'update':
        Y.applyUpdate(doc, fromBase64(message.update), FROM_EDITOR);
        break;
      case 'changed':
        workspace.touch(id);
        break;
      case 'title':
        workspace.setTitle(id, message.title);
        break;
      case 'focus':
        setFocus(message.focused ? message.area : null);
        break;
      case 'active':
        setActive(message.active);
        setLink(message.link);
        break;
      case 'image':
        workspace
          .imageData(message.src)
          .then((data) => send({ type: 'image', src: message.src, data }))
          .catch((error: Error) =>
            send({ type: 'image', src: message.src, data: null, error: error.message }),
          );
        break;
      case 'openLink':
        if (/^https?:\/\//i.test(message.href)) void Linking.openURL(message.href);
        break;
      case 'error':
        console.warn('[editor]', message.message);
        break;
    }
  };

  const command = (name: EditorCommand) => send({ type: 'command', command: name });
  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={0}
    >
      <View style={{ flex: 1, backgroundColor: theme.c.panel }}>
        <WebView
          ref={webview}
          source={{ html: editorHtml }}
          originWhitelist={['*']}
          onMessage={onMessage}
          onContentProcessDidTerminate={() => {
            ready.current = false;
            webview.current?.reload();
          }}
          onShouldStartLoadWithRequest={(request) => {
            if (request.url === 'about:blank' || request.url.startsWith('data:')) return true;
            if (/^https?:\/\//i.test(request.url)) void Linking.openURL(request.url);
            return false;
          }}
          style={[styles.web, { backgroundColor: theme.c.panel }]}
          containerStyle={{ backgroundColor: theme.c.panel }}
          hideKeyboardAccessoryView
          keyboardDisplayRequiresUserAction={false}
          automaticallyAdjustContentInsets={false}
          contentInsetAdjustmentBehavior="never"
          allowsLinkPreview={false}
          setSupportMultipleWindows={false}
          textInteractionEnabled
          webviewDebuggingEnabled={__DEV__}
        />
      </View>
      {editable && focus ? (
        <Toolbar
          area={focus}
          active={active}
          onCommand={command}
          onLink={() => setLinkDialog(true)}
        />
      ) : null}
      <LinkDialog
        visible={linkDialog}
        initial={link}
        onClose={() => setLinkDialog(false)}
        onSubmit={(href) => {
          setLinkDialog(false);
          send({ type: 'link', href });
        }}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  web: { flex: 1 },
});

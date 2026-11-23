/**
 * Редактор заметки: TipTap в WebView (apps/web/src/mobile-editor) + родная панель
 * форматирования над клавиатурой. Документ — копия Y.Doc заметки: изменения ходят
 * в обе стороны, сеть и офлайн-хранилище остаются на стороне приложения.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActionSheetIOS, Alert, Keyboard, Linking, Platform, StyleSheet, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { WebView, type WebViewMessageEvent, type WebViewProps } from 'react-native-webview';
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

/** Тип файла по фактическому расширению: mimeType из галереи бывает от исходника (HEIC). */
function mimeOf(asset: { uri: string; mimeType?: string | null }) {
  const ext = asset.uri.split('?')[0].split('.').pop()?.toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (ext === 'heic' || ext === 'heif') return 'image/heic';
  return asset.mimeType ?? 'image/jpeg';
}

/** Типы WebView 14 с TypeScript 6 сводят пропсы к never (P = undefined) — описываем сами. */
type WebViewHandle = { injectJavaScript(script: string): void; reload(): void };
const EditorWebView = WebView as unknown as React.ComponentType<
  WebViewProps & { ref?: React.Ref<WebViewHandle> }
>;

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
  const webview = useRef<WebViewHandle>(null);
  const ready = useRef(false);
  const [focus, setFocus] = useState<'title' | 'body' | null>(null);
  const [active, setActive] = useState<EditorActive>({});
  const [link, setLink] = useState<string | null>(null);
  const [linkDialog, setLinkDialog] = useState(false);
  // Высота клавиатуры: панель ставим вплотную над ней (KeyboardAvoidingView здесь не помог —
  // WKWebView сам сдвигает содержимое, и панель уезжала под клавиатуру).
  const [keyboard, setKeyboard] = useState(0);
  useEffect(() => {
    const ios = Platform.OS === 'ios';
    const show = Keyboard.addListener(ios ? 'keyboardWillShow' : 'keyboardDidShow', (event) =>
      setKeyboard(event.endCoordinates.height),
    );
    const hide = Keyboard.addListener(ios ? 'keyboardWillHide' : 'keyboardDidHide', () =>
      setKeyboard(0),
    );
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  const title = workspace.noteTitle(id);
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
          title: workspace.noteTitle(id) || initial.title,
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

  /** Камера или галерея → файл на телефоне → картинка в месте курсора. */
  async function pick(source: 'camera' | 'library') {
    try {
      const options: ImagePicker.ImagePickerOptions = {
        mediaTypes: ['images'],
        quality: 0.85,
        exif: false,
        // HEIC с iPhone сервер (sharp) не читает — просим у iOS совместимый JPEG
        preferredAssetRepresentationMode:
          ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
      };
      let result: ImagePicker.ImagePickerResult;
      if (source === 'camera') {
        const permission = await ImagePicker.requestCameraPermissionsAsync();
        if (!permission.granted) {
          Alert.alert('Нет доступа к камере', 'Разрешите доступ в настройках iOS: SelfNote → Камера.');
          return;
        }
        result = await ImagePicker.launchCameraAsync(options);
      } else
        result = await ImagePicker.launchImageLibraryAsync({
          ...options,
          allowsMultipleSelection: true,
          selectionLimit: 10,
          orderedSelection: true,
        });
      if (result.canceled) return;
      for (const asset of result.assets) {
        const src = await workspace.addImage(asset.uri, mimeOf(asset));
        send({ type: 'insertImage', src });
      }
    } catch (error) {
      Alert.alert('Не удалось добавить картинку', (error as Error).message);
    }
  }
  function chooseImage() {
    const camera = 'Сделать фото';
    const library = 'Выбрать из галереи';
    if (Platform.OS === 'ios')
      ActionSheetIOS.showActionSheetWithOptions(
        { options: [camera, library, 'Отмена'], cancelButtonIndex: 2 },
        (index) => {
          if (index === 0) void pick('camera');
          if (index === 1) void pick('library');
        },
      );
    else
      Alert.alert('Картинка', undefined, [
        { text: camera, onPress: () => void pick('camera') },
        { text: library, onPress: () => void pick('library') },
        { text: 'Отмена', style: 'cancel' },
      ]);
  }
  return (
    <View style={{ flex: 1, backgroundColor: theme.c.panel }}>
      <View style={{ flex: 1 }}>
        <EditorWebView
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
      {editable && keyboard > 0 && !linkDialog ? (
        <View
          style={[styles.toolbar, { bottom: Platform.OS === 'ios' ? keyboard : 0 }]}
          pointerEvents="box-none"
        >
          <Toolbar
          area={focus ?? 'body'}
          active={active}
          onCommand={command}
          onLink={() => setLinkDialog(true)}
          onImage={chooseImage}
          />
        </View>
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
    </View>
  );
}

const styles = StyleSheet.create({
  web: { flex: 1 },
  toolbar: { position: 'absolute', left: 0, right: 0 },
});

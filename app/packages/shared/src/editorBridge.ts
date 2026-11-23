/**
 * Протокол между мобильным приложением (React Native) и редактором в WebView
 * (apps/web/src/mobile-editor). Сообщения — JSON; обновления Yjs — в base64.
 */
export type EditorCommand =
  | 'bold'
  | 'italic'
  | 'strike'
  | 'spoiler'
  | 'heading2'
  | 'heading3'
  | 'bulletList'
  | 'orderedList'
  | 'taskList'
  | 'undo'
  | 'redo'
  | 'blur'
  | 'focusEnd';

/** Какие кнопки панели сейчас «нажаты». */
export type EditorActive = Partial<Record<EditorCommand | 'link' | 'image', boolean>>;

export interface EditorTheme {
  dark: boolean;
  /** CSS-переменные: background, text, muted, accent, … */
  colors: Record<string, string>;
}

/** Приложение → редактор. */
export type ToEditor =
  | {
      type: 'init';
      state: string;
      title: string;
      titlePlaceholder: string;
      editable: boolean;
      theme: EditorTheme;
      focusTitle: boolean;
    }
  | { type: 'update'; update: string }
  | { type: 'title'; title: string }
  | { type: 'editable'; editable: boolean }
  | { type: 'theme'; theme: EditorTheme }
  | { type: 'command'; command: EditorCommand }
  | { type: 'link'; href: string | null }
  /** Вставить картинку (src — local-image:… или /api/attachments/…) в место курсора. */
  | { type: 'insertImage'; src: string }
  | { type: 'image'; src: string; data: string | null; error?: string };

/** Редактор → приложение. */
export type FromEditor =
  | { type: 'ready' }
  | { type: 'update'; update: string }
  /** Правка пользователя (не синхронизация) — поднять заметку в списке. */
  | { type: 'changed' }
  | { type: 'title'; title: string }
  | { type: 'focus'; focused: boolean; area: 'title' | 'body' | null }
  | { type: 'active'; active: EditorActive; link: string | null }
  | { type: 'image'; src: string }
  | { type: 'openLink'; href: string }
  | { type: 'error'; message: string };

/**
 * Сборка редактора для мобильного приложения: один IIFE-скрипт и один CSS,
 * которые scripts/pack-mobile-editor.mjs собирает в HTML-строку для WebView
 * (mobile/src/editor/editorHtml.ts).
 */
import { defineConfig } from 'vite';
export default defineConfig({
  define: { 'process.env.NODE_ENV': '"production"' },
  build: {
    outDir: '.mobile-editor',
    emptyOutDir: true,
    cssCodeSplit: false,
    target: 'safari15',
    lib: {
      entry: 'src/mobile-editor/main.ts',
      formats: ['iife'],
      name: 'SelfNoteEditor',
      fileName: () => 'editor.js',
      cssFileName: 'editor',
    },
  },
});

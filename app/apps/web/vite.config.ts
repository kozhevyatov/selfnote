import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      manifest: {
        name: 'SelfNote — заметки и задачи',
        short_name: 'SelfNote',
        lang: 'ru',
        theme_color: '#ECEBE7',
        background_color: '#ECEBE7',
        display: 'standalone',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          // maskable — во весь квадрат: форму (круг, «сквиркл») вырезает система
          {
            src: '/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,woff2,svg,png}'],
        navigateFallbackDenylist: [/^\/api\//, /^\/collab/, /^\/s\//],
      },
    }),
  ],
  build: {
    // манифест нужен серверу, чтобы подключить скрипт публичной страницы /s/<token>
    manifest: true,
    rollupOptions: {
      input: {
        main: 'index.html',
        share: 'src/share/main.ts',
      },
      output: {
        manualChunks(id) {
          if (id.includes('/node_modules/')) {
            if (id.includes('/@tiptap/') || id.includes('/prosemirror-')) return 'editor';
            if (
              id.includes('/yjs/') ||
              id.includes('/y-protocols/') ||
              id.includes('/lib0/') ||
              id.includes('/@hocuspocus/') ||
              id.includes('/y-indexeddb/')
            )
              return 'sync';
            return 'vendor';
          }
        },
      },
    },
  },
  server: {
    proxy: {
      '/api': { target: 'http://127.0.0.1:1339' },
      '/collab': { target: 'ws://127.0.0.1:1339', ws: true },
      '/s/': { target: 'http://127.0.0.1:1339' },
    },
  },
});

// Собирает HTML редактора для WebView мобильного приложения в mobile/src/editor/editorHtml.ts.
// Шрифт Golos Text встраивается в CSS (data: URI), чтобы редактор работал без сети.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.resolve(here, '..');
const build = path.join(web, '.mobile-editor');
const target = path.resolve(web, '../../../mobile/src/editor/editorHtml.ts');

const js = readFileSync(path.join(build, 'editor.js'), 'utf8');
const cssFile = readdirSync(build).find((name) => name.endsWith('.css'));
const css = cssFile ? readFileSync(path.join(build, cssFile), 'utf8') : '';

const require = createRequire(import.meta.url);
const fontDir = path.dirname(require.resolve('@fontsource/golos-text/package.json'));
let fonts = '';
for (const weight of [400, 600, 700, 800]) {
  fonts += readFileSync(path.join(fontDir, `${weight}.css`), 'utf8')
    .replace(/,\s*url\(\.\/files\/[^)]+\.woff\)\s*format\('woff'\)/g, '')
    .replace(/url\(\.\/files\/([^)]+\.woff2)\)/g, (_m, file) => {
      const data = readFileSync(path.join(fontDir, 'files', file)).toString('base64');
      return `url(data:font/woff2;base64,${data})`;
    });
}

const html = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">
<style>${fonts}</style>
<style>${css}</style>
</head>
<body>
<div id="page"><textarea id="title" rows="1" aria-label="Название заметки"></textarea><div id="editor"></div></div>
<script>${js.replace(/<\/script/gi, '<\\/script')}</script>
</body>
</html>`;

mkdirSync(path.dirname(target), { recursive: true });
writeFileSync(
  target,
  `// Сгенерировано: npm run build:mobile-editor -w @selfnote/web. Не редактировать вручную.\n` +
    `// Исходники — app/apps/web/src/mobile-editor.\n` +
    `/* eslint-disable */\nconst html: string = ${JSON.stringify(html)};\nexport default html;\n`,
);
console.log(`mobile/src/editor/editorHtml.ts: ${(html.length / 1024).toFixed(0)} КБ`);

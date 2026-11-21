/**
 * Нормализация чужого HTML (Synology Note Station и т. п.) под схему редактора:
 * строки-<div> → абзацы с переносами, стили → жирный/курсив/зачёркнутый,
 * флажки → задачи, таблицы → строки текста.
 */
const BLOCK = new Set([
  'DIV',
  'P',
  'UL',
  'OL',
  'LI',
  'TABLE',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'BLOCKQUOTE',
  'PRE',
  'HR',
  'SECTION',
  'ARTICLE',
  'HEADER',
  'FOOTER',
]);
const isBlock = (node: Node) => node.nodeType === 1 && BLOCK.has((node as Element).tagName);
const isEmptyLine = (el: Element) => !el.textContent?.trim() && !el.querySelector('img,input');

export interface NormalizeStats {
  tables: number;
  checkboxes: number;
}

export function normalizeHtml(html: string, stats: NormalizeStats = { tables: 0, checkboxes: 0 }) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const body = doc.body;
  body.querySelectorAll('script,style,meta,link,title').forEach((el) => el.remove());

  // 1. Оформление из style="…" → семантические теги, которые понимает редактор.
  for (const el of [...body.querySelectorAll<HTMLElement>('[style]')]) {
    const style = el.style;
    const wrap = (tag: string) => {
      const w = doc.createElement(tag);
      while (el.firstChild) w.appendChild(el.firstChild);
      el.appendChild(w);
    };
    const weight = style.fontWeight;
    if (weight === 'bold' || weight === 'bolder' || Number(weight) >= 600) wrap('strong');
    if (style.fontStyle === 'italic') wrap('em');
    if (`${style.textDecoration} ${style.textDecorationLine}`.includes('line-through')) wrap('s');
    el.removeAttribute('style');
  }
  body.querySelectorAll('font').forEach((el) => el.replaceWith(...el.childNodes));

  // 2. Таблиц в редакторе нет — каждая строка становится строкой текста «ячейка | ячейка».
  for (const table of [...body.querySelectorAll('table')]) {
    const lines = [...table.querySelectorAll('tr')].map((row) =>
      [...row.querySelectorAll('td,th')].map((c) => c.textContent?.trim() ?? '').join(' | '),
    );
    const p = doc.createElement('p');
    lines.forEach((line, i) => {
      if (i) p.appendChild(doc.createElement('br'));
      p.appendChild(doc.createTextNode(line));
    });
    table.replaceWith(p);
    stats.tables++;
  }

  // 3. Контейнеры <div> с блоками внутри разворачиваем; одиночный текст в них — в строку-<div>.
  for (;;) {
    const container = [...body.querySelectorAll('div')].find((d) =>
      [...d.childNodes].some(isBlock),
    );
    if (!container) break;
    const parts: Node[] = [];
    let run: Node[] = [];
    const flush = () => {
      if (run.some((n) => n.textContent?.trim() || (n as Element).querySelector?.('img'))) {
        const line = doc.createElement('div');
        run.forEach((n) => line.appendChild(n));
        parts.push(line);
      }
      run = [];
    };
    for (const child of [...container.childNodes]) {
      if (isBlock(child)) {
        flush();
        parts.push(child);
      } else run.push(child);
    }
    flush();
    container.replaceWith(...parts);
  }

  // 4. Подряд идущие строки-<div> → один абзац с переносами; пустая строка = новый абзац.
  const parents = new Set([...body.querySelectorAll('div')].map((d) => d.parentElement!));
  for (const parent of parents) {
    let paragraph: HTMLParagraphElement | null = null;
    for (const child of [...parent.childNodes]) {
      if (child.nodeType === 1 && (child as Element).tagName === 'DIV') {
        const line = child as Element;
        if (isEmptyLine(line)) {
          paragraph = null;
          line.remove();
          continue;
        }
        // строка с флажком — отдельная задача, не склеиваем с соседними строками
        const task = Boolean(line.querySelector('input'));
        if (!paragraph || task) {
          paragraph = doc.createElement('p');
          line.replaceWith(paragraph);
        } else {
          paragraph.appendChild(doc.createElement('br'));
          line.remove();
        }
        while (line.firstChild) paragraph.appendChild(line.firstChild);
        while (paragraph.lastChild?.nodeName === 'BR') paragraph.lastChild.remove();
        if (task) paragraph = null;
      } else if (child.nodeType === 3 && !child.textContent?.trim()) continue;
      else paragraph = null;
    }
  }

  // 4b. Двойной перенос внутри абзаца (<br><br>) — граница абзацев (так Note Station
  //     разделяет строфы и абзацы внутри одного <div>).
  const blank = (n: Node) => n.nodeType === 3 && !n.textContent?.trim();
  for (const p of [...body.querySelectorAll('p')]) {
    const nodes = [...p.childNodes];
    const groups: Node[][] = [[]];
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (node.nodeName === 'BR') {
        let j = i + 1;
        while (j < nodes.length && blank(nodes[j])) j++;
        if (j < nodes.length && nodes[j].nodeName === 'BR') {
          while (j < nodes.length && (nodes[j].nodeName === 'BR' || blank(nodes[j]))) j++;
          groups.push([]);
          i = j - 1;
          continue;
        }
      }
      groups[groups.length - 1].push(node);
    }
    const filled = groups.filter((g) =>
      g.some((n) => n.textContent?.trim() || n.nodeName === 'IMG'),
    );
    if (filled.length <= 1) continue;
    p.replaceWith(
      ...filled.map((group) => {
        const next = doc.createElement('p');
        group.forEach((n) => next.appendChild(n));
        while (next.firstChild?.nodeName === 'BR' || (next.firstChild && blank(next.firstChild)))
          next.firstChild.remove();
        while (next.lastChild?.nodeName === 'BR' || (next.lastChild && blank(next.lastChild)))
          next.lastChild.remove();
        return next;
      }),
    );
  }

  // 5. Флажки → задачи (строка с флажком становится пунктом чек-листа).
  for (const input of [...body.querySelectorAll('input')]) {
    const isCheckbox = input.type === 'checkbox' || /checkbox/i.test(input.className);
    if (!isCheckbox) {
      input.remove();
      continue;
    }
    stats.checkboxes++;
    const checked =
      input.hasAttribute('checked') || /\bchecked\b/i.test(input.className) || input.checked;
    const holder = input.closest('li') ?? input.closest('p');
    input.remove();
    if (!holder) continue;
    if (holder.tagName === 'LI') {
      holder.setAttribute('data-type', 'taskItem');
      holder.setAttribute('data-checked', String(checked));
      holder.parentElement?.setAttribute('data-type', 'taskList');
      continue;
    }
    const item = doc.createElement('li');
    item.setAttribute('data-type', 'taskItem');
    item.setAttribute('data-checked', String(checked));
    const text = doc.createElement('p');
    while (holder.firstChild) text.appendChild(holder.firstChild);
    item.appendChild(text);
    const previous = holder.previousElementSibling;
    if (previous?.tagName === 'UL' && previous.getAttribute('data-type') === 'taskList') {
      previous.appendChild(item);
      holder.remove();
    } else {
      const list = doc.createElement('ul');
      list.setAttribute('data-type', 'taskList');
      list.appendChild(item);
      holder.replaceWith(list);
    }
  }

  // 6. Заголовки h1/h4–h6 → уровни редактора, лишние атрибуты — прочь.
  for (const h of [...body.querySelectorAll('h1,h4,h5,h6')]) {
    const n = doc.createElement(h.tagName === 'H1' ? 'h2' : 'h3');
    while (h.firstChild) n.appendChild(h.firstChild);
    h.replaceWith(n);
  }
  for (const el of [...body.querySelectorAll('*')])
    for (const attr of [...el.attributes])
      if (
        !/^(href|src|alt|data-type|data-checked|data-spoiler|data-highlight|data-text-color|due|start)$/.test(
          attr.name,
        )
      )
        el.removeAttribute(attr.name);
  return body.innerHTML;
}

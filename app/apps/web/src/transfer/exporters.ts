/**
 * Экспорт заметок пользователя (работает и без сети — данные берутся с устройства):
 * - Markdown + картинки (ZIP): папки = книжки/подразделы, файл = заметка;
 * - полная копия SelfNote (ZIP): структура + содержимое без потерь, для переноса.
 */
import { yDocToProsemirrorJSON } from '@tiptap/y-tiptap';
import { writeZip, type ZipInput } from '@selfnote/shared';
import type { Note } from '@selfnote/shared';
import { imageBlob } from '../attachments';
import type { Workspace } from '../store';
import { frontMatter, toMarkdown, type PMNode } from './markdown';

export interface ExportResult {
  blob: Blob;
  name: string;
  notes: number;
  images: number;
  warnings: string[];
}
const EXT: Record<string, string> = {
  'image/webp': 'webp',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
};
const safe = (name: string) =>
  [...name]
    .map((c) => (c.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(c) ? ' ' : c))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'Без названия';
const stamp = () => new Date().toISOString().slice(0, 10);

/**
 * Заметки для экспорта. Заметки под паролем попадают в архив только открытыми
 * (и тогда — в расшифрованном виде), закрытые пропускаются.
 */
function notesFor(workspace: Workspace, notebookId?: string | null) {
  return [...workspace.metadata.values()]
    .filter(
      (n) =>
        !n.deletedAt &&
        (notebookId === undefined || n.notebookId === notebookId) &&
        (!n.encrypted || workspace.secure.isUnlocked(n.id)),
    )
    .map((n) => (n.encrypted && n.hideTitle ? { ...n, title: workspace.title(n) } : n));
}
function lockedWarning(workspace: Workspace, warnings: string[]) {
  const locked = [...workspace.metadata.values()].filter(
    (n) => !n.deletedAt && n.encrypted && !workspace.secure.isUnlocked(n.id),
  ).length;
  if (locked)
    warnings.push(
      `Заметки под паролем (${locked}) пропущены — откройте их перед экспортом, чтобы включить в архив`,
    );
}
async function content(workspace: Workspace, note: Note): Promise<PMNode> {
  if (note.encrypted) {
    const doc = workspace.secure.doc(note.id);
    if (!doc) throw new Error('Заметка под паролем закрыта');
    return yDocToProsemirrorJSON(doc, 'content') as PMNode;
  }
  const entry = workspace.note(note.id);
  await entry.ready;
  return yDocToProsemirrorJSON(entry.doc, 'content') as PMNode;
}
/** Собирает картинки заметок: src → путь в архиве. */
class Images {
  readonly files: ZipInput[] = [];
  private paths = new Map<string, string | null>();
  constructor(
    private userId: string,
    private warnings: string[],
  ) {}
  pathOf(src: string) {
    return this.paths.get(src) ?? null;
  }
  async add(src: string, title: string) {
    if (this.paths.has(src)) return this.paths.get(src) ?? null;
    try {
      const blob = await imageBlob(src, this.userId);
      const path = `attachments/${this.files.length + 1}.${EXT[blob.type] ?? 'bin'}`;
      this.files.push({ name: path, data: new Uint8Array(await blob.arrayBuffer()) });
      this.paths.set(src, path);
      return path;
    } catch {
      this.warnings.push(`«${title}»: картинка недоступна без сети — пропущена`);
      this.paths.set(src, null);
      return null;
    }
  }
}
async function collectImages(node: PMNode, images: Images, title: string) {
  if (node.type === 'image') await images.add(String(node.attrs?.src ?? ''), title);
  for (const child of node.content ?? []) await collectImages(child, images, title);
}

export async function exportMarkdown(
  workspace: Workspace,
  notebookId?: string | null,
  progress?: (done: number, total: number) => void,
): Promise<ExportResult> {
  const warnings: string[] = [];
  const images = new Images(workspace.userId, warnings);
  const notes = notesFor(workspace, notebookId);
  lockedWarning(workspace, warnings);
  const files: ZipInput[] = [];
  const used = new Set<string>();
  let done = 0;
  for (const note of notes) {
    const book = note.notebookId ? workspace.notebooks.get(note.notebookId) : undefined;
    const section = note.sectionId ? workspace.sections.get(note.sectionId) : undefined;
    const folders = [book && safe(book.name), section && safe(section.name)].filter(
      Boolean,
    ) as string[];
    let path = [...folders, safe(note.title)].join('/');
    for (let i = 2; used.has(path.toLowerCase()); i++)
      path = [...folders, `${safe(note.title)} (${i})`].join('/');
    used.add(path.toLowerCase());
    const doc = await content(workspace, note);
    await collectImages(doc, images, note.title);
    const up = '../'.repeat(folders.length);
    const body = toMarkdown(doc, (src, alt) => {
      const target = images.pathOf(src);
      return target ? `![${alt}](${up}${target})` : '';
    });
    files.push({
      name: `${path}.md`,
      date: new Date(note.updatedAt),
      data:
        frontMatter({
          title: note.title || 'Без названия',
          notebook: book?.name,
          section: section?.name,
          tags: note.tags,
          pinned: note.pinned || undefined,
          updated: note.updatedAt,
        }) +
        body +
        '\n',
    });
    progress?.(++done, notes.length);
  }
  const zip = await writeZip([...files, ...images.files]);
  const scope = notebookId ? safe(workspace.notebooks.get(notebookId)?.name ?? 'книжка') : 'все';
  return {
    blob: new Blob([new Uint8Array(zip)], { type: 'application/zip' }),
    name: `selfnote-markdown-${scope}-${stamp()}.zip`,
    notes: notes.length,
    images: images.files.length,
    warnings,
  };
}

export async function exportSelfnote(
  workspace: Workspace,
  progress?: (done: number, total: number) => void,
): Promise<ExportResult> {
  const warnings: string[] = [];
  const images = new Images(workspace.userId, warnings);
  const notes = notesFor(workspace);
  lockedWarning(workspace, warnings);
  const out = [];
  let done = 0;
  for (const note of notes) {
    const doc = await content(workspace, note);
    await collectImages(doc, images, note.title);
    const remap = (node: PMNode): PMNode => ({
      ...node,
      ...(node.type === 'image'
        ? { attrs: { ...node.attrs, src: images.pathOf(String(node.attrs?.src ?? '')) ?? '' } }
        : {}),
      ...(node.content ? { content: node.content.map(remap) } : {}),
    });
    out.push({
      id: note.id,
      title: note.title,
      notebookId: note.notebookId,
      sectionId: note.sectionId,
      tags: note.tags,
      pinned: note.pinned,
      updatedAt: note.updatedAt,
      content: remap(doc),
    });
    progress?.(++done, notes.length);
  }
  const data = {
    format: 'selfnote-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    notebooks: [...workspace.notebooks.values()],
    sections: [...workspace.sections.values()],
    tags: [...workspace.tags.keys()],
    notes: out,
  };
  const zip = await writeZip([
    { name: 'selfnote.json', data: JSON.stringify(data) },
    ...images.files,
  ]);
  return {
    blob: new Blob([new Uint8Array(zip)], { type: 'application/zip' }),
    name: `selfnote-export-${stamp()}.zip`,
    notes: notes.length,
    images: images.files.length,
    warnings,
  };
}

export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

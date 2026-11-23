/**
 * Картинки заметок на телефоне (аналог apps/web/src/attachments.ts):
 * - новая картинка копируется в документы приложения и вставляется в заметку
 *   как `local-image:<uuid>`; при связи загружается на сервер, и src в документе
 *   меняется на `/api/attachments/<id>` — так же, как это делает веб;
 * - картинки с сервера кэшируются на диск, чтобы открываться без сети.
 * Таблица src → файл лежит в LocalStore (kv, ключ `image:<src>`).
 */
import { Directory, File, Paths } from 'expo-file-system';
import * as Y from 'yjs';
import { token } from '../auth';
import { uuid } from '../ids';
import type { LocalStore } from './localStore';

interface ImageRecord {
  /** Имя файла в папке images. */
  file: string;
  mime: string;
  /** Адрес на сервере после загрузки. */
  remote?: string;
  /** Сервер отказался принять файл (формат, размер) — больше не пытаемся. */
  rejected?: string;
  /** Когда запись появилась (мс): свежие не чистим — картинка могла ещё не попасть в заметку. */
  added?: number;
}

export class Images {
  private readonly dir: Directory;
  private memory = new Map<string, Promise<string>>();
  private uploading = false;

  constructor(
    private readonly server: string,
    private readonly store: LocalStore,
    account: string,
  ) {
    this.dir = new Directory(Paths.document, 'images', account);
    try {
      this.dir.create({ intermediates: true, idempotent: true });
    } catch {
      /* уже есть */
    }
  }

  /** Сохранить снимок/файл из галереи; возвращает src для вставки в заметку. */
  async add(uri: string, mime = 'image/jpeg'): Promise<string> {
    const id = uuid();
    const ext = mime === 'image/png' ? 'png' : mime === 'image/heic' ? 'heic' : 'jpg';
    const name = `${id}.${ext}`;
    await new File(uri).copy(new File(this.dir, name));
    const src = `local-image:${id}`;
    await this.store.set(`image:${src}`, { file: name, mime, added: Date.now() } satisfies ImageRecord);
    return src;
  }

  /** data: URI для редактора: с диска, иначе с сервера (с сохранением на диск). */
  data(src: string): Promise<string> {
    let pending = this.memory.get(src);
    if (!pending) {
      pending = this.load(src);
      pending.catch(() => this.memory.delete(src));
      this.memory.set(src, pending);
      if (this.memory.size > 60) this.memory.delete(this.memory.keys().next().value!);
    }
    return pending;
  }
  private async load(src: string): Promise<string> {
    const record = await this.store.get<ImageRecord>(`image:${src}`);
    if (record) {
      const file = new File(this.dir, record.file);
      if (file.exists) return `data:${record.mime};base64,${await file.base64()}`;
    }
    if (!src.startsWith('/api/attachments/'))
      throw new Error('Картинка ещё не загружена с другого устройства');
    const name = `${src.split('/').pop()!.replace(/[^\w-]/g, '')}.webp`;
    const target = new File(this.dir, name);
    if (!target.exists)
      await File.downloadFileAsync(this.server + src, target, {
        headers: { Authorization: `Bearer ${await token()}`, 'X-SelfNote-Client': 'app' },
        idempotent: true,
      } as never).catch(() => {
        throw new Error('Изображение недоступно без сети');
      });
    await this.store.set(`image:${src}`, {
      file: name,
      mime: 'image/webp',
      added: Date.now(),
    } satisfies ImageRecord);
    return `data:image/webp;base64,${await target.base64()}`;
  }

  /**
   * Удаляет с телефона картинки, на которые не ссылается ни одна заметка на устройстве.
   * Вызывать, когда открыты документы всех заметок (иначе удалятся картинки неоткрытых).
   * Не трогает: ещё не отправленные на сервер, отклонённые сервером, появившиеся за последние сутки.
   * Удалённое с телефона при необходимости снова скачается с сервера.
   */
  async cleanup(docs: Y.Doc[]) {
    const used = new Set<string>();
    const walk = (node: Y.XmlFragment | Y.XmlElement) => {
      for (const child of node.toArray())
        if (child instanceof Y.XmlElement) {
          if (child.nodeName === 'image') used.add(String(child.getAttribute('src')));
          walk(child);
        }
    };
    for (const doc of docs) walk(doc.getXmlFragment('content'));
    const records = await this.store.entries<ImageRecord>('image:');
    const fresh = Date.now() - 86400000;
    const keep = (src: string, record: ImageRecord) =>
      used.has(src) ||
      (record.remote !== undefined && used.has(record.remote)) ||
      (src.startsWith('local-image:') && !record.remote) ||
      (record.added ?? 0) > fresh;
    const keptFiles = new Set<string>();
    const dropped: [string, ImageRecord][] = [];
    for (const [key, record] of records) {
      if (keep(key.slice(6), record)) keptFiles.add(record.file);
      else dropped.push([key, record]);
    }
    let freed = 0;
    for (const [key, record] of dropped) {
      await this.store.delete(key);
      this.memory.delete(key.slice(6));
      if (keptFiles.has(record.file)) continue;
      const file = new File(this.dir, record.file);
      try {
        if (file.exists) {
          freed += file.size ?? 0;
          file.delete();
        }
      } catch {
        /* файл занят или уже удалён */
      }
    }
    if (dropped.length)
      console.log(`[images] очистка: ${dropped.length} записей, ${(freed / 1048576).toFixed(1)} МБ`);
  }

  /**
   * Загружает на сервер картинки, вставленные на телефоне, и меняет их src в документах.
   * canUpload(noteId) — заметка уже есть на сервере и её можно править.
   */
  async upload(docs: [noteId: string, doc: Y.Doc][], canUpload: (noteId: string) => boolean) {
    if (this.uploading) return;
    this.uploading = true;
    try {
      for (const [noteId, doc] of docs) {
        const images: Y.XmlElement[] = [];
        const walk = (node: Y.XmlFragment | Y.XmlElement) => {
          for (const child of node.toArray())
            if (child instanceof Y.XmlElement) {
              if (child.nodeName === 'image' && String(child.getAttribute('src')).startsWith('local-image:'))
                images.push(child);
              walk(child);
            }
        };
        walk(doc.getXmlFragment('content'));
        if (!images.length || !canUpload(noteId)) continue;
        for (const image of images) {
          const src = String(image.getAttribute('src'));
          const record = await this.store.get<ImageRecord>(`image:${src}`);
          if (!record || record.rejected) continue; // чужая (загрузит другое устройство) или отклонена
          let remote = record.remote;
          if (!remote) {
            const file = new File(this.dir, record.file);
            if (!file.exists) continue;
            // multipart собираем сами: FormData в fetch React Native/Expo ведёт себя по-разному
            // (expo/fetch не принимает части вида { uri, name, type }).
            const boundary = `----selfnote${uuid().replace(/-/g, '')}`;
            const encoder = new TextEncoder();
            const head = encoder.encode(
              `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${record.file}"\r\n` +
                `Content-Type: ${record.mime}\r\n\r\n`,
            );
            const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
            const data = await file.bytes();
            const body = new Uint8Array(head.length + data.length + tail.length);
            body.set(head, 0);
            body.set(data, head.length);
            body.set(tail, head.length + data.length);
            const response = await fetch(`${this.server}/api/attachments${noteId ? `?noteId=${noteId}` : ''}`, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${await token()}`,
                'X-SelfNote-Client': 'app',
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
              },
              body,
            });
            if (response.status === 400 || response.status === 413) {
              const reason = ((await response.json().catch(() => null)) as { message?: string } | null)
                ?.message;
              await this.store.set(`image:${src}`, { ...record, rejected: reason || 'Файл не принят' });
              console.warn('[images] сервер не принял картинку', src, reason);
              continue;
            }
            if (!response.ok) throw new Error(`Загрузка картинки: ${response.status}`);
            remote = ((await response.json()) as { url: string }).url;
            await this.store.set(`image:${src}`, { ...record, remote });
            // серверную копию показываем из того же файла, без скачивания
            await this.store.set(`image:${remote}`, {
              file: record.file,
              mime: record.mime,
              added: Date.now(),
            });
          }
          image.setAttribute('src', remote);
        }
      }
    } catch (error) {
      console.warn('[images] загрузка отложена', error);
    } finally {
      this.uploading = false;
    }
  }
}

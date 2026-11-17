import { uuid } from './ids';
import * as Y from 'yjs';
import { api, token } from './api';
import type { Workspace } from './store';
interface StoredImage {
  key: string;
  blob: Blob;
  pending: boolean;
  remote?: string;
}
function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('selfnote-images', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('images', { keyPath: 'key' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function put(record: StoredImage) {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('images', 'readwrite');
    tx.objectStore('images').put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}
async function get(key: string) {
  const db = await database();
  const result = await new Promise<StoredImage | undefined>((resolve, reject) => {
    const r = db.transaction('images').objectStore('images').get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  db.close();
  return result;
}
export async function storeImage(file: File, userId: string) {
  if (!file.type.startsWith('image/')) throw new Error('Выберите изображение');
  if (file.size > 20 * 1024 * 1024) throw new Error('Изображение должно быть меньше 20 МБ');
  const src = `local-image:${uuid()}`;
  await put({ key: `${userId}:${src}`, blob: file, pending: true });
  return src;
}
/** Содержимое картинки заметки: из локального кэша или с сервера (с кэшированием). */
export async function imageBlob(src: string, userId: string): Promise<Blob> {
  const key = `${userId}:${src}`,
    cached = await get(key);
  if (cached) return cached.blob;
  if (!src.startsWith('/api/attachments/')) throw new Error('Изображение ещё не синхронизировано');
  const response = await fetch(src, { headers: { Authorization: `Bearer ${await token()}` } });
  if (!response.ok) throw new Error('Изображение недоступно');
  const blob = await response.blob();
  await put({ key, blob, pending: false });
  return blob;
}
export async function imageUrl(src: string, userId: string) {
  return URL.createObjectURL(await imageBlob(src, userId));
}
let busy = false;
export async function flushImages(workspace: Workspace) {
  if (busy || !navigator.onLine) return;
  busy = true;
  try {
    const docs: Y.Doc[] = [];
    for (const entry of workspace.notes.values()) {
      await entry.ready;
      docs.push(entry.doc);
    }
    docs.push(...workspace.secure.docs());
    for (const doc of docs) {
      const images: Y.XmlElement[] = [];
      function walk(node: Y.XmlFragment | Y.XmlElement) {
        for (const child of node.toArray())
          if (child instanceof Y.XmlElement) {
            if (
              child.nodeName === 'image' &&
              String(child.getAttribute('src')).startsWith('local-image:')
            )
              images.push(child);
            walk(child);
          }
      }
      walk(doc.getXmlFragment('content'));
      for (const image of images) {
        const src = image.getAttribute('src')!;
        const record = await get(`${workspace.userId}:${src}`);
        if (!record) continue;
        let remote = record.remote;
        if (!remote) {
          const form = new FormData();
          form.append('file', record.blob, 'image');
          const noteId = [...workspace.notes].find(([, entry]) => entry.doc === doc)?.[0];
          if (noteId && !workspace.canEdit(noteId)) continue;
          if (noteId) await workspace.whenSynced(noteId);
          const url = noteId ? `/api/attachments?noteId=${noteId}` : '/api/attachments';
          const result = await api<{ url: string }>(url, {
            method: 'POST',
            body: form,
          });
          remote = result.url;
          await put({ ...record, pending: false, remote });
          await put({ key: `${workspace.userId}:${remote}`, blob: record.blob, pending: false });
        }
        image.setAttribute('src', remote);
      }
    }
  } catch (error) {
    console.warn('Загрузка изображения отложена', error);
  } finally {
    busy = false;
  }
}

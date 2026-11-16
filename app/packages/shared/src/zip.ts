/**
 * Минимальный ZIP без зависимостей: работает в браузере и в Node 22
 * (Blob, Response, CompressionStream/DecompressionStream с 'deflate-raw').
 * Без ZIP64: до 65 535 файлов и 4 ГБ — для заметок и бэкапов домашнего сервера достаточно.
 */
export interface ZipInput {
  name: string;
  data: Uint8Array | string;
  date?: Date;
}
export interface ZipEntry {
  name: string;
  size: number;
  date: Date;
  read(): Promise<Uint8Array>;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream) {
  const body = new Blob([new Uint8Array(data)]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(body).arrayBuffer());
}
const encoder = new TextEncoder();
const utf8 = new TextDecoder();

function dosDateTime(date: Date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}
function fromDos(time: number, date: number) {
  return new Date(
    ((date >> 9) & 0x7f) + 1980,
    ((date >> 5) & 0x0f) - 1,
    date & 0x1f,
    (time >> 11) & 0x1f,
    (time >> 5) & 0x3f,
    (time & 0x1f) * 2,
  );
}

/** Собрать ZIP. compress=true — deflate (для текста/JSON), false — без сжатия (картинки). */
export async function writeZip(files: ZipInput[], compress = true): Promise<Uint8Array> {
  if (files.length > 0xffff) throw new Error('Слишком много файлов для одного архива');
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const raw = typeof file.data === 'string' ? encoder.encode(file.data) : file.data;
    const name = encoder.encode(file.name);
    let method = 0;
    let body = raw;
    if (compress && raw.length > 64) {
      const packed = await pipe(raw, new CompressionStream('deflate-raw'));
      if (packed.length < raw.length) {
        method = 8;
        body = packed;
      }
    }
    if (offset + body.length > 0xffffffff) throw new Error('Архив больше 4 ГБ не поддерживается');
    const crc = crc32(raw);
    const { time, date } = dosDateTime(file.date ?? new Date());
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // имена в UTF-8
    local.setUint16(8, method, true);
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, raw.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    const head = new DataView(new ArrayBuffer(46));
    head.setUint32(0, 0x02014b50, true);
    head.setUint16(4, 20, true);
    head.setUint16(6, 20, true);
    head.setUint16(8, 0x0800, true);
    head.setUint16(10, method, true);
    head.setUint16(12, time, true);
    head.setUint16(14, date, true);
    head.setUint32(16, crc, true);
    head.setUint32(20, body.length, true);
    head.setUint32(24, raw.length, true);
    head.setUint16(28, name.length, true);
    head.setUint32(42, offset, true);
    parts.push(new Uint8Array(local.buffer), name, body);
    central.push(new Uint8Array(head.buffer), name);
    offset += 30 + name.length + body.length;
  }
  const centralSize = central.reduce((sum, p) => sum + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Прочитать ZIP: список файлов (без папок) с ленивым чтением содержимого. */
export function readZip(data: Uint8Array): ZipEntry[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let eocd = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 22 - 0xffff); i--)
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new Error('Файл не похож на ZIP-архив');
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const entries: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error('Повреждённый ZIP-архив');
    const method = view.getUint16(at + 10, true);
    const time = view.getUint16(at + 12, true);
    const date = view.getUint16(at + 14, true);
    const packed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localOffset = view.getUint32(at + 42, true);
    const name = utf8.decode(data.subarray(at + 46, at + 46 + nameLength)).replace(/\\/g, '/');
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;
    if (method !== 0 && method !== 8) throw new Error(`Неподдерживаемое сжатие в архиве (${name})`);
    entries.push({
      name,
      size,
      date: fromDos(time, date),
      async read() {
        const start =
          localOffset +
          30 +
          view.getUint16(localOffset + 26, true) +
          view.getUint16(localOffset + 28, true);
        const body = data.subarray(start, start + packed);
        return method === 8 ? pipe(body, new DecompressionStream('deflate-raw')) : body.slice();
      },
    });
  }
  return entries;
}

export async function readZipText(entry: ZipEntry) {
  return utf8.decode(await entry.read());
}

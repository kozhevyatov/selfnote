/**
 * Шифрование заметок под паролем — только на устройстве (WebCrypto, работает и в Node 22).
 * AES-GCM 256, ключ — PBKDF2-SHA-256 из пароля и соли заметки. Параметры KDF хранятся
 * рядом с шифром, поэтому позже можно перейти на argon2id, не ломая старые заметки.
 */
export interface Kdf {
  name: 'PBKDF2';
  hash: 'SHA-256';
  iterations: number;
  salt: string;
}
export interface Envelope {
  v: 1;
  kdf: Kdf;
  iv: string;
  data: string;
}
/** Рекомендация OWASP для PBKDF2-SHA-256 (2023+). */
export const KDF_ITERATIONS = 600_000;

const subtle = () => globalThis.crypto.subtle;
const bytes = (value: Uint8Array): ArrayBuffer => new Uint8Array(value).buffer as ArrayBuffer;

export function toBase64(data: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < data.length; i += 0x8000)
    binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
  return btoa(binary);
}
export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
export const toBase64Url = (data: Uint8Array) =>
  toBase64(data).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const fromBase64Url = (value: string) =>
  fromBase64(value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4));

function randomBytes(length: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}
export function newKdf(iterations = KDF_ITERATIONS): Kdf {
  return { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: toBase64(randomBytes(16)) };
}
/** 32 байта ключа из пароля. */
export async function deriveKey(password: string, kdf: Kdf): Promise<Uint8Array> {
  if (kdf.name !== 'PBKDF2' || kdf.hash !== 'SHA-256')
    throw new Error('Неизвестный формат шифрования. Обновите приложение.');
  const base = await subtle().importKey(
    'raw',
    bytes(new TextEncoder().encode(password.normalize('NFC'))),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await subtle().deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      iterations: kdf.iterations,
      salt: bytes(fromBase64(kdf.salt)),
    },
    base,
    256,
  );
  return new Uint8Array(bits);
}
async function aesKey(raw: Uint8Array) {
  return subtle().importKey('raw', bytes(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function seal(key: Uint8Array, kdf: Kdf, plaintext: Uint8Array): Promise<Envelope> {
  const iv = randomBytes(12);
  const data = await subtle().encrypt(
    { name: 'AES-GCM', iv: bytes(iv) },
    await aesKey(key),
    bytes(plaintext),
  );
  return { v: 1, kdf, iv: toBase64(iv), data: toBase64(new Uint8Array(data)) };
}
export class WrongPasswordError extends Error {
  constructor() {
    super('Неверный пароль');
  }
}
export async function unseal(key: Uint8Array, envelope: Envelope): Promise<Uint8Array> {
  try {
    const data = await subtle().decrypt(
      { name: 'AES-GCM', iv: bytes(fromBase64(envelope.iv)) },
      await aesKey(key),
      bytes(fromBase64(envelope.data)),
    );
    return new Uint8Array(data);
  } catch {
    throw new WrongPasswordError();
  }
}
export function parseEnvelope(value: string): Envelope {
  const envelope = JSON.parse(value) as Envelope;
  if (envelope?.v !== 1 || !envelope.kdf || !envelope.iv || !envelope.data)
    throw new Error('Повреждённые данные заметки');
  return envelope;
}

/**
 * Ключ заметки для публичной ссылки — во фрагменте адреса (#…), который браузер
 * не отправляет на сервер. С паролем ссылки ключ дополнительно зашифрован ключом
 * из этого пароля: «p.<соль>.<iv>.<шифр>», без пароля — «k.<ключ>».
 */
export async function wrapShareKey(key: Uint8Array, linkPassword?: string): Promise<string> {
  if (!linkPassword) return `k.${toBase64Url(key)}`;
  const kdf = newKdf();
  const envelope = await seal(await deriveKey(linkPassword, kdf), kdf, key);
  return [
    'p',
    toBase64Url(fromBase64(kdf.salt)),
    toBase64Url(fromBase64(envelope.iv)),
    toBase64Url(fromBase64(envelope.data)),
  ].join('.');
}
export function shareKeyNeedsPassword(fragment: string) {
  return fragment.startsWith('p.');
}
export async function unwrapShareKey(fragment: string, linkPassword?: string): Promise<Uint8Array> {
  const parts = fragment.split('.');
  if (parts[0] === 'k' && parts[1]) return fromBase64Url(parts[1]);
  if (parts[0] !== 'p' || parts.length !== 4) throw new Error('Ссылка повреждена');
  if (!linkPassword) throw new WrongPasswordError();
  const kdf: Kdf = {
    name: 'PBKDF2',
    hash: 'SHA-256',
    iterations: KDF_ITERATIONS,
    salt: toBase64(fromBase64Url(parts[1])),
  };
  return unseal(await deriveKey(linkPassword, kdf), {
    v: 1,
    kdf,
    iv: toBase64(fromBase64Url(parts[2])),
    data: toBase64(fromBase64Url(parts[3])),
  });
}

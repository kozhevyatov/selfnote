/**
 * WebCrypto для React Native. В Hermes нет crypto.subtle, а общий код (shared/secure.ts)
 * шифрует заметки через него. Невидимый WebView с https-адресом — защищённый контекст,
 * там crypto.subtle есть (системная реализация iOS/Android). Здесь — подмена
 * globalThis.crypto.subtle с ровно теми операциями, что нужны shared/secure.ts:
 * importKey (raw: PBKDF2, AES-GCM), deriveBits (PBKDF2), encrypt/decrypt (AES-GCM).
 * Ключи не покидают процесс приложения.
 */
import { useEffect, useRef } from 'react';
import { View } from 'react-native';
import { WebView, type WebViewMessageEvent, type WebViewProps } from 'react-native-webview';
import { fromBase64, toBase64 } from '@selfnote/shared';

type Handle = { injectJavaScript(script: string): void };
const HostWebView = WebView as unknown as React.ComponentType<
  WebViewProps & { ref?: React.Ref<Handle> }
>;

type Request =
  | { op: 'pbkdf2'; password: string; salt: string; iterations: number; hash: string; length: number }
  | { op: 'encrypt' | 'decrypt'; key: string; iv: string; data: string };

const HTML = `<!doctype html><html><body><script>
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const bytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const reply = (id, ok, value) => window.ReactNativeWebView.postMessage(JSON.stringify({ id, ok, value }));
window.__crypto = async (id, r) => {
  try {
    const subtle = crypto.subtle;
    if (r.op === 'pbkdf2') {
      const base = await subtle.importKey('raw', bytes(r.password), 'PBKDF2', false, ['deriveBits']);
      const bits = await subtle.deriveBits({ name: 'PBKDF2', hash: r.hash, iterations: r.iterations, salt: bytes(r.salt) }, base, r.length);
      return reply(id, true, b64(new Uint8Array(bits)));
    }
    const key = await subtle.importKey('raw', bytes(r.key), 'AES-GCM', false, [r.op]);
    const out = await subtle[r.op]({ name: 'AES-GCM', iv: bytes(r.iv) }, key, bytes(r.data));
    reply(id, true, b64(new Uint8Array(out)));
  } catch (e) {
    reply(id, false, String((e && e.name) || e));
  }
};
window.ReactNativeWebView.postMessage(JSON.stringify({ ready: !!(window.crypto && crypto.subtle) }));
</script></body></html>`;

let host: Handle | null = null;
let ready: Promise<void>;
let markReady: () => void = () => undefined;
const resetReady = () => {
  ready = new Promise((resolve) => (markReady = resolve));
};
resetReady();
let next = 1;
const pending = new Map<number, { resolve: (v: string) => void; reject: (e: Error) => void }>();

async function call(request: Request): Promise<Uint8Array> {
  await ready;
  const id = next++;
  const value = await new Promise<string>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    host?.injectJavaScript(`window.__crypto(${id}, ${JSON.stringify(request)});true;`);
  });
  return fromBase64(value);
}

const asBytes = (data: BufferSource): Uint8Array =>
  data instanceof Uint8Array
    ? data
    : ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);
const buffer = (u8: Uint8Array) => u8.slice().buffer as ArrayBuffer;

/** Ключ — просто байты и алгоритм; сами операции выполняет WebView. */
interface ShimKey {
  algorithm: string;
  raw: Uint8Array;
}
const subtle = {
  async importKey(format: string, data: BufferSource, algorithm: string | { name: string }) {
    if (format !== 'raw') throw new Error('Поддерживается только raw-ключ');
    const name = typeof algorithm === 'string' ? algorithm : algorithm.name;
    return { algorithm: name, raw: asBytes(data).slice() } satisfies ShimKey;
  },
  async deriveBits(
    params: { name: string; hash: string; iterations: number; salt: BufferSource },
    key: ShimKey,
    length: number,
  ) {
    const bits = await call({
      op: 'pbkdf2',
      password: toBase64(key.raw),
      salt: toBase64(asBytes(params.salt)),
      iterations: params.iterations,
      hash: params.hash,
      length,
    });
    return buffer(bits);
  },
  async encrypt(params: { iv: BufferSource }, key: ShimKey, data: BufferSource) {
    return buffer(
      await call({ op: 'encrypt', key: toBase64(key.raw), iv: toBase64(asBytes(params.iv)), data: toBase64(asBytes(data)) }),
    );
  },
  async decrypt(params: { iv: BufferSource }, key: ShimKey, data: BufferSource) {
    try {
      return buffer(
        await call({ op: 'decrypt', key: toBase64(key.raw), iv: toBase64(asBytes(params.iv)), data: toBase64(asBytes(data)) }),
      );
    } catch {
      throw new Error('OperationError');
    }
  },
};

const g = globalThis as unknown as { crypto: Record<string, unknown> };
if (g.crypto && !g.crypto.subtle) g.crypto.subtle = subtle;

/** Смонтировать один раз в корне приложения. */
export function CryptoHost() {
  const ref = useRef<Handle>(null);
  useEffect(() => {
    host = ref.current;
    return () => {
      host = null;
      resetReady();
    };
  }, []);
  const onMessage = (event: WebViewMessageEvent) => {
    const message = JSON.parse(event.nativeEvent.data) as
      | { ready: boolean }
      | { id: number; ok: boolean; value: string };
    if ('ready' in message) {
      host = ref.current;
      if (message.ready) markReady();
      else console.warn('[crypto] в WebView нет crypto.subtle');
      return;
    }
    const entry = pending.get(message.id);
    pending.delete(message.id);
    if (!entry) return;
    if (message.ok) entry.resolve(message.value);
    else entry.reject(new Error(message.value));
  };
  return (
    <View style={{ width: 0, height: 0, position: 'absolute', opacity: 0 }} pointerEvents="none">
      <HostWebView
        ref={ref}
        source={{ html: HTML, baseUrl: 'https://localhost/' }}
        originWhitelist={['*']}
        onMessage={onMessage}
        onContentProcessDidTerminate={() => resetReady()}
        style={{ width: 1, height: 1 }}
        javaScriptEnabled
      />
    </View>
  );
}

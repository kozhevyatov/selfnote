/**
 * То, чего нет в Hermes/React Native, но ждут yjs, lib0 и @hocuspocus/provider.
 * Подключается первым — из index.js.
 */
import 'react-native-get-random-values';

const g = globalThis as unknown as Record<string, unknown>;

// Hocuspocus подписывается на window 'online'/'focus'; в RN window есть, а addEventListener — нет.
if (typeof g.addEventListener !== 'function') {
  g.addEventListener = () => undefined;
  g.removeEventListener = () => undefined;
}

// TextDecoder появился в Hermes не везде; общий пакет создаёт его при загрузке модуля.
if (typeof g.TextDecoder !== 'function') {
  class Utf8Decoder {
    readonly encoding = 'utf-8';
    decode(input?: ArrayBuffer | ArrayBufferView): string {
      if (!input) return '';
      const bytes =
        input instanceof Uint8Array
          ? input
          : ArrayBuffer.isView(input)
            ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
            : new Uint8Array(input);
      let out = '';
      for (let i = 0; i < bytes.length; ) {
        const b = bytes[i++];
        let code: number;
        if (b < 0x80) code = b;
        else if (b < 0xe0) code = ((b & 0x1f) << 6) | (bytes[i++] & 0x3f);
        else if (b < 0xf0)
          code = ((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
        else
          code =
            ((b & 0x07) << 18) |
            ((bytes[i++] & 0x3f) << 12) |
            ((bytes[i++] & 0x3f) << 6) |
            (bytes[i++] & 0x3f);
        out += String.fromCodePoint(code);
      }
      return out;
    }
  }
  g.TextDecoder = Utf8Decoder;
}

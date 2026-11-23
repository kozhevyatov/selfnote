// lib0 (зависимость yjs) в React Native тянет пакет isomorphic-webcrypto.
// Ему нужен только getRandomValues — его даёт react-native-get-random-values (src/polyfills.ts).
const webcrypto = {
  ensureSecure: () => Promise.resolve(),
  get subtle() {
    return globalThis.crypto && globalThis.crypto.subtle;
  },
  getRandomValues: (array) => globalThis.crypto.getRandomValues(array),
};
module.exports = webcrypto;
module.exports.default = webcrypto;

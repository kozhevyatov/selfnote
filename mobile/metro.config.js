// Общий код с сервером и вебом берём прямо из исходников app/packages/shared/src.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
const shared = path.resolve(__dirname, '../app/packages/shared/src');
const ownEntry = path.join(__dirname, 'index.js');

config.watchFolders = [...(config.watchFolders ?? []), shared];

const fallback = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = fallback ?? context.resolveRequest;
  if (moduleName === 'isomorphic-webcrypto/src/react-native')
    return { type: 'sourceFile', filePath: path.join(__dirname, 'src/shims/isomorphic-webcrypto.js') };
  if (moduleName === '@selfnote/shared')
    return { type: 'sourceFile', filePath: path.join(shared, 'index.ts') };
  if (context.originModulePath.startsWith(shared + path.sep)) {
    // В shared импорты с расширением .js (NodeNext), а лежат там .ts-файлы.
    if (moduleName.startsWith('.') && moduleName.endsWith('.js'))
      return {
        type: 'sourceFile',
        filePath: path.resolve(path.dirname(context.originModulePath), moduleName.slice(0, -3) + '.ts'),
      };
    // yjs и прочие пакеты — только из mobile/node_modules: вторая копия yjs ломает instanceof.
    if (!moduleName.startsWith('.'))
      return resolve({ ...context, originModulePath: ownEntry }, moduleName, platform);
  }
  return resolve(context, moduleName, platform);
};

module.exports = config;

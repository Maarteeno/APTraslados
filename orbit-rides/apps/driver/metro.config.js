// Metro en un monorepo.
//
// Por defecto Metro solo mira la carpeta del proyecto, así que no ve
// apps/shared ni packages/domain y falla con "Unable to resolve @orbit/client".
// Estas tres líneas son las que lo arreglan, y son la razón número uno por la
// que un monorepo de React Native "no compila" sin explicación clara.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// 1. Metro vigila todo el monorepo, para que el hot reload funcione al editar
//    el cliente compartido.
config.watchFolders = [monorepoRoot];

// 2. Resuelve módulos primero en la app y después en la raíz del monorepo,
//    donde npm hoistea todo.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules'),
];

// 3. Sin esto, Metro sube por el árbol de directorios buscando node_modules y
//    puede encontrar dos copias de React. Dos copias de React producen el error
//    "Invalid hook call", que no dice nada sobre la causa real.
config.resolver.disableHierarchicalLookup = true;

module.exports = config;

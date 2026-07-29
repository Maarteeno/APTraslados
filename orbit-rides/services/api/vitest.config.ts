import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const domainSrc = fileURLToPath(new URL('../../packages/domain/src/index.ts', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // Los tests apuntan al CÓDIGO FUENTE de @orbit/domain, no a su dist.
      //
      // Sin este alias, `npm test` en un clone recién bajado falla: el
      // package.json de @orbit/domain apunta a dist/, que todavía no existe.
      // Los tests no deberían necesitar un build previo para correr. También
      // hace que la suite sea inmune a que el symlink del workspace en
      // node_modules/@orbit esté roto o creado en otro sistema operativo.
      '@orbit/domain': domainSrc,
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    reporters: ['verbose'],
    setupFiles: ['test/setup.ts'],
    // Procesos, no hilos: el pool de workers comparte memoria entre archivos y
    // acá hay singletons por módulo (config y logger). Un resetConfig() de un
    // test afectaría a otro. Aislar es más lento y más honesto.
    //
    // En Vitest 4 esto va a nivel superior: `poolOptions` se eliminó.
    pool: 'forks',
    isolate: true,
  },
});

# ─────────────────────────────────────────────────────────────────────────────
# Orbit Rides API — build multi-stage
#
# Cuatro etapas:
#   deps       instala TODO (incluye devDependencies) para poder compilar
#   build      compila TypeScript con tsc -b
#   prod-deps  instala SOLO dependencias de producción, en limpio
#   runtime    imagen final: node_modules de producción + dist + migraciones
#
# El stage prod-deps separado reemplaza al `npm prune --omit=dev` que había
# antes: prune sobre un árbol de workspaces puede dejar el enlace del workspace
# en un estado raro, y un `npm ci --omit=dev` en limpio es determinista.
#
# NOTA sobre workspaces: npm HOISTEA todo a /repo/node_modules. No existen
# packages/domain/node_modules ni services/api/node_modules — verificado con
# `npm ci` en limpio. Solo hay que copiar el node_modules de la raíz.
# ─────────────────────────────────────────────────────────────────────────────

FROM node:22-alpine AS deps
WORKDIR /repo
# Los manifests primero: si no cambian, Docker reusa la capa de instalación.
COPY package.json package-lock.json ./
COPY packages/domain/package.json packages/domain/
COPY services/api/package.json services/api/
RUN npm ci


FROM node:22-alpine AS build
WORKDIR /repo
COPY --from=deps /repo/node_modules ./node_modules
# .dockerignore (en la RAÍZ del contexto de build) excluye node_modules y dist,
# así que este COPY no pisa el node_modules que acabamos de traer.
COPY . .
# tsc -b respeta el orden de las project references: primero el dominio, después
# la API. No depende del symlink del workspace, porque el tsconfig de la API
# resuelve @orbit/domain con `paths`.
#
# Los `test -f` fallan el build si el layout de salida cambia. Sin esto, un
# cambio de rootDir produciría una imagen que compila pero no arranca.
RUN npx tsc -b packages/domain services/api \
 && test -f services/api/dist/src/index.js \
 && test -f services/api/dist/scripts/migrate.js \
 && test -f services/api/dist/scripts/seed.js


FROM node:22-alpine AS prod-deps
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/domain/package.json packages/domain/
COPY services/api/package.json services/api/
RUN npm ci --omit=dev


FROM node:22-alpine AS runtime
WORKDIR /repo
ENV NODE_ENV=production

# Usuario sin privilegios. Nada corre como root.
RUN addgroup -g 10001 -S orbit && adduser -u 10001 -S orbit -G orbit

COPY --from=prod-deps /repo/node_modules  ./node_modules
COPY --from=prod-deps /repo/package.json  ./package.json

COPY --from=build /repo/packages/domain/package.json ./packages/domain/package.json
COPY --from=build /repo/packages/domain/dist         ./packages/domain/dist

COPY --from=build /repo/services/api/package.json ./services/api/package.json
COPY --from=build /repo/services/api/dist         ./services/api/dist
# Las migraciones viajan con la imagen: el mismo artefacto que corre es el que
# conoce su esquema.
COPY --from=build /repo/services/api/migrations ./services/api/migrations

RUN chown -R orbit:orbit /repo

USER orbit
EXPOSE 8080

# El healthcheck usa readiness, que verifica Postgres y Redis de verdad.
HEALTHCHECK --interval=15s --timeout=4s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "services/api/dist/src/index.js"]

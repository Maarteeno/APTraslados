# Orbit Rides

Backend de una plataforma de viajes. Monorepo TypeScript: dominio puro, API
Fastify, Postgres con PostGIS, Redis, Docker.

**Estado:** el motor funciona de punta a punta. `npm run smoke` recorre el flujo
completo —cotizar, pedir, despachar, aceptar, viajar, liquidar— contra Postgres
con PostGIS y Redis reales, y pasa. Las dos apps Android existen y compilan; la
de pasajero corrió el flujo completo en el emulador, y a la de conductor le queda
un mapa que se ve negro.

> **¿Retomando en otra máquina?** Empezá por **[MIGRAR.md](MIGRAR.md)**: qué
> copiar, en qué orden levantarlo, y exactamente qué está verificado y qué no.

---

## Cómo correrlo

### Paso 0 — verificar qué tenés

```powershell
docker --version      # necesitás Docker Desktop corriendo
node --version        # v22 o superior
```

Si `docker` no responde, andá a la sección "Sin Docker" más abajo.

### Paso 1 — probar la lógica sin levantar nada

Esto no necesita Docker, ni base de datos, ni red. Son 129 tests que corren en
dos segundos y validan tarifas, comisiones, ledger, máquina de estados,
dispatch, y el arranque completo del servidor HTTP.

```powershell
cd C:\Users\gdelgado\Documents\GitHub\APTraslados\orbit-rides
npm install
npm run verify
```

Esperado: `85 passed` en el dominio y `44 passed` en el API, y `found 0
vulnerabilities` en el install.

**Si ves 18 errores `Cannot find module '@orbit/domain'`**, tu `node_modules`
tiene enlaces de workspace creados en otro sistema operativo. Los enlaces que
npm usa para los workspaces no son portables entre Linux y Windows. Borralo y
reinstalá:

```powershell
cmd /c "rmdir /s /q node_modules" 2>$null
Remove-Item -Recurse -Force packages\domain\dist, services\api\dist -ErrorAction SilentlyContinue
Remove-Item -Force packages\domain\tsconfig.tsbuildinfo, services\api\tsconfig.tsbuildinfo -ErrorAction SilentlyContinue
npm install
npm run verify
```

Se usa `cmd /c rmdir` y no `Remove-Item` porque PowerShell se traba con
symlinks y junctions roscos.

Si `npm test` falla con un error de esbuild tipo *"You installed esbuild for
another platform"*, es el gate de scripts de npm 11:

```powershell
npm approve-scripts --allow-scripts-pending
npm run verify
```

### Paso 2 — levantar todo con Docker

```powershell
docker compose up -d --build
```

La primera vez tarda unos minutos (baja PostGIS y compila). Después:

```powershell
docker compose ps
```

Esperá a que los tres contenedores digan `healthy` o `running`. Si `api`
reinicia en loop, mirá `docker compose logs api`.

El Dockerfile tiene cuatro etapas: `deps` (todas las dependencias para
compilar), `build` (`tsc -b` más verificación de que los tres artefactos de
salida existen), `prod-deps` (`npm ci --omit=dev` en limpio) y `runtime`. La
imagen final pesa ~26 MB de aplicación: no lleva TypeScript, ni vitest, ni el
código fuente.

**Un detalle de npm workspaces que cuesta un build:** npm hoistea *todo* a
`node_modules` de la raíz. `packages/domain/node_modules` y
`services/api/node_modules` **no existen**. Copiarlos en el Dockerfile falla con
`failed to compute cache key: "/repo/packages/domain/node_modules": not found`.

### Paso 3 — preparar el ruteo (una sola vez)

```powershell
docker compose --profile prepare up osrm-download osrm-build
```

Baja el extracto de OpenStreetMap de Uruguay (~50 MB) y lo preprocesa con OSRM.
Tarda unos minutos y no hay que repetirlo, salvo que quieras actualizar el mapa.

**Por qué OSRM y no un proveedor comercial.** El ruteo tiene dos usos y uno de
ellos es el que cuesta plata:

| Uso | Cuántas llamadas |
|---|---|
| Ruta de la cotización | 1 por cotización |
| **Matriz de ETA del dispatch** | conductores × olas, **por cada intento de asignación** |

La segunda escala con los intentos, no con los viajes cerrados. Con 30
conductores y 180 viajes cada uno son del orden de 80.000 elementos de matriz por
mes, y con un proveedor por request eso domina la factura — del orden de
US$ 400/mes, contra un margen de contribución de unos US$ 3.600. OSRM la resuelve
local, gratis y sin cuota.

Si OSRM no está preparado, el API **no falla**: cae a una estimación local
(línea recta × 1,3) y lo declara en el campo `routeProvider` de la cotización, así
que un ETA estimado nunca se confunde con uno real.

### Paso 4 — esquema y datos de prueba

```powershell
docker compose exec api node services/api/dist/scripts/migrate.js
docker compose exec api node services/api/dist/scripts/seed.js
```

El seed imprime los teléfonos con los que podés entrar.

### Paso 5 — probar el flujo completo con un comando

```powershell
npm run smoke
```

Esto hace, contra el API que acabás de levantar: login de los cinco usuarios,
pone tres conductores online, cotiza, pide el viaje, espera la oferta del
dispatch, acepta, recorre el viaje, liquida, revisa la bitácora, consulta
ganancias y verifica que el ledger cierre en cero. También comprueba que **no**
se pueda reutilizar una cotización, que un segundo conductor **no** pueda robar
el viaje, que no se puedan saltear estados y que un pasajero **no** entre al
panel admin.

Termina con `TODO OK` o te dice exactamente qué falló y en qué paso.

Si el API está en otra máquina o puerto:

```powershell
$env:API_URL="http://192.168.1.50:8080"; npm run smoke
```

### Desarrollo con recarga en caliente

```powershell
docker compose -f docker-compose.yml -f docker-compose.dev.yml up
```

Monta el código del host y corre `tsx watch`: guardás un archivo y el API se
reinicia solo.

### Sin Docker

Necesitás Postgres 16 **con PostGIS** y Redis 7 corriendo en tu máquina. La
extensión PostGIS es el punto complicado en Windows: viene en el instalador de
EnterpriseDB como componente opcional (Stack Builder). Si no querés lidiar con
eso, usá Docker solo para las dos bases:

```powershell
docker run -d --name orbit-pg -e POSTGRES_USER=orbit -e POSTGRES_PASSWORD=orbit `
  -e POSTGRES_DB=orbit -p 5432:5432 postgis/postgis:16-3.4-alpine
docker run -d --name orbit-redis -p 6379:6379 redis:7-alpine
```

Y después el API en Node local, que es más cómodo para depurar:

```powershell
Copy-Item .env.example .env
npm install
npm run build
npm run migrate
npm run seed
npm run dev          # queda escuchando en 8080
```

En otra terminal: `npm run smoke`.

### Si algo falla

```powershell
docker compose logs --tail=80 api        # el error suele estar acá
docker compose logs --tail=40 postgres
```

**Arrancar con la base limpia.** Necesario si corriste el sistema con una
versión que escribía datos mal — el ledger es inmutable por diseño, así que un
asiento equivocado no se puede editar y queda ahí:

```powershell
docker compose down -v                   # el -v borra los volúmenes
docker compose up -d --build
docker compose exec api node services/api/dist/scripts/migrate.js
docker compose exec api node services/api/dist/scripts/seed.js
npm run smoke
```

En producción esto no es una opción: un asiento mal escrito se corrige con un
asiento de AJUSTE que lo compensa, nunca borrando ni editando. Los triggers de
`ledger_entries` lo impiden a nivel de motor. Si alguna vez necesitás corregir
plata en producción, el camino es `ref_type = 'adjustment'`, no un `UPDATE`.

Errores probables y qué significan:

| Síntoma | Causa |
|---|---|
| `orbit-api` en loop de reinicio | Mirá `docker compose logs api`. Si dice `unable to determine transport target for "pino-pretty"`, tenés `LOG_PRETTY=true` en una imagen construida sin devDependencies |
| `NO_DRIVERS` en todos los viajes | No pusiste conductores online (el paso que hace `npm run smoke`) |
| `usuario con ese teléfono no encontrado` | Falta correr el seed |
| `relation "cities"/"users" does not exist` | Falta correr el `migrate`, o falló |
| `extension "postgis" is not available` | Estás usando la imagen `postgres` en vez de `postgis/postgis` |
| `ECONNREFUSED` en el smoke | El API no está levantado, o está en otro puerto |
| `la cotización venció` | Pasaron más de 120 s entre cotizar y pedir |
| `Permission denied` bajando el .pbf de OSRM | El contenedor de descarga necesita `user: "0:0"` para escribir en el volumen |
| `orbit-osrm` reiniciando | Falta preparar los datos. El contenedor lo dice en sus logs |

---

## Probar el flujo completo con curl

### 1. Login (modo desarrollo)

No hay Firebase todavía. El API firma sus propios tokens; la configuración
**prohíbe** este modo en producción.

```powershell
# Pasajero
curl -X POST http://localhost:8080/v1/auth/dev-login `
  -H "Content-Type: application/json" `
  -d '{\"phone\":\"+59899100001\"}'
```

Guardá el `token`. Teléfonos que crea el seed:

| Teléfono | Rol | Plan |
|---|---|---|
| `+59899100001` | pasajero | — |
| `+59899100000` | admin | — |
| `+59899774019` | conductor | Pro (2 %) |
| `+59899100002` | conductor | Free (12 %) |
| `+59899100003` | conductor | Free (12 %) |

### 2. Poner conductores online

Sin esto **no hay a quién ofertarle** y todos los viajes terminan en
`NO_DRIVERS`. Es el error más común al probar por primera vez.

```powershell
$d = (curl -s -X POST http://localhost:8080/v1/auth/dev-login -H "Content-Type: application/json" -d '{\"phone\":\"+59899774019\"}' | ConvertFrom-Json).token

curl -X POST http://localhost:8080/v1/driver/position `
  -H "Authorization: Bearer $d" -H "Content-Type: application/json" `
  -d '{\"lat\":-34.9089,\"lng\":-56.1601,\"isOnline\":true}'
```

### 3. Cotizar

```powershell
curl -X POST http://localhost:8080/v1/quotes `
  -H "Authorization: Bearer $TOKEN_PASAJERO" -H "Content-Type: application/json" `
  -d '{\"origin\":{\"lat\":-34.9112,\"lng\":-56.1553},\"destination\":{\"lat\":-34.9066,\"lng\":-56.2044}}'
```

Devuelve `quoteId`, `fareCents`, el desglose y una `signature`. **El monto no se
puede alterar**: está firmado con HMAC y vence en 120 segundos.

### 4. Pedir el viaje

```powershell
curl -X POST http://localhost:8080/v1/trips `
  -H "Authorization: Bearer $TOKEN_PASAJERO" -H "Content-Type: application/json" `
  -d '{\"quoteId\":\"<el-quoteId>\",\"paymentMethod\":\"cash\"}'
```

El dispatch arranca en background. Mirá los logs:

```powershell
docker compose logs -f api
```

### 5. El conductor acepta y completa

```powershell
# ¿Tengo oferta?
curl http://localhost:8080/v1/driver/offer -H "Authorization: Bearer $TOKEN_CONDUCTOR"

curl -X POST http://localhost:8080/v1/trips/<tripId>/accept   -H "Authorization: Bearer $TOKEN_CONDUCTOR"
curl -X POST http://localhost:8080/v1/trips/<tripId>/arrived  -H "Authorization: Bearer $TOKEN_CONDUCTOR"
curl -X POST http://localhost:8080/v1/trips/<tripId>/start    -H "Authorization: Bearer $TOKEN_CONDUCTOR"
curl -X POST http://localhost:8080/v1/trips/<tripId>/complete `
  -H "Authorization: Bearer $TOKEN_CONDUCTOR" -H "Content-Type: application/json" `
  -d '{\"actualDistanceMeters\":5900,\"actualDurationSeconds\":840}'
```

### 6. Ver la historia completa

```powershell
curl http://localhost:8080/v1/trips/<tripId> -H "Authorization: Bearer $TOKEN_PASAJERO"
```

El campo `events` es la bitácora append-only: cada transición con quién la hizo
y cuándo.

### 7. Verificar la contabilidad

```powershell
curl http://localhost:8080/v1/admin/ledger/integrity -H "Authorization: Bearer $TOKEN_ADMIN"
```

`healthy: true` significa que todas las transacciones del ledger suman cero. Si
alguna vez da `false`, hay un bug de dinero.

---

## Conectar el emulador de Android

El emulador no ve `localhost` del host: ese `localhost` es el del propio
emulador. Usá la IP especial que Android reserva para el host:

```
http://10.0.2.2:8080
```

Para un dispositivo físico en la misma red WiFi, la IP de tu PC:

```powershell
ipconfig | Select-String IPv4
# http://192.168.x.x:8080
```

Android bloquea HTTP en claro desde API 28. Para desarrollo, en
`app.json` de Expo:

```json
{ "expo": { "android": { "usesCleartextTraffic": true } } }
```

### Requisitos del emulador (en tu máquina, no acá)

1. Android Studio con el SDK.
2. Un AVD con **Google Play Services** — hace falta para push (FCM).
3. Aceleración por hardware: WHPX o Hyper-V en Windows.
4. Recomendado: API 34, imagen x86_64.

**No pude verificar esta parte:** mi entorno no tiene Docker ni emulador de
Android. Lo que sí está verificado más abajo.

---

## Qué está verificado

### Ejecutado de punta a punta, en la máquina de Gastón

`npm run smoke` pasa completo contra Docker: Postgres 16 con PostGIS, Redis 7 y
el API en su imagen de producción.

| Paso | Qué comprueba |
|---|---|
| 1-2 | Readiness real, login de los 5 usuarios del seed |
| 3-4 | Limpieza de viajes previos, tres conductores online en Redis |
| 5 | Cotización: $270 UYU, 5,9 km, desglose y firma HMAC |
| 6 | Una cotización inexistente se rechaza |
| 7-8 | Viaje creado; **reutilizar la cotización devuelve 409** |
| 9 | El dispatch ofertó y el conductor recibió la oferta |
| 10 | Aceptado, **comisión congelada en 2,00 %** |
| 11 | **Un segundo conductor no puede tomar el mismo viaje** (409) |
| 12 | **No se pueden saltear estados** (completar sin iniciar → 409) |
| 13-14 | Viaje recorrido y liquidado; comisión + ganancia = tarifa exacta |
| 15 | Bitácora completa: `REQUESTED → MATCHING → ACCEPTED → ARRIVED → IN_PROGRESS → COMPLETED` |
| 16 | En efectivo la comisión queda **a cobrar**, y el delta del saldo es exacto |
| 17 | Todas las transacciones del ledger suman cero |
| 18 | 401 sin token, 403 de pasajero a admin, 403 de pasajero a endpoint de conductor |

Las 7 migraciones se aplican contra PostGIS real, incluidos los triggers
diferidos del ledger, los triggers append-only y los índices únicos parciales.

### Suite automatizada

| Qué | Resultado |
|---|---|
| Lógica de dominio (`@orbit/domain`) | **85 tests** |
| Servicio API (`@orbit/api`) | **44 tests** |
| Compilación `tsc -b --force`, TypeScript estricto | **0 errores** |
| Migraciones contra el parser de PostgreSQL (`libpg_query`) | 7 archivos validan |
| YAML de Compose y k8s | 9 archivos validan |
| Aritmética del modelo financiero | 81/81 celdas verificadas en Python |
| `npm audit` | **0 vulnerabilidades** |

`tsconfig.base.json` tiene `strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes` y `verbatimModuleSyntax`. Cero `any` explícitos,
cero `@ts-ignore`.

### La lección: los tests verdes no alcanzaron

Con 110 tests pasando y el typecheck limpio, **nueve bugs aparecieron recién al
correrlo de verdad**:

| Bug | Por qué ningún test lo vio |
|---|---|
| `packages/domain/node_modules` no existe (npm hoistea) | No hay Docker en un test unitario |
| `.dockerignore` en la carpeta equivocada | Ídem |
| `pino-pretty` es devDependency y la imagen no la tiene | Los tests corren con devDependencies |
| Ruta de migraciones rota en el layout compilado | Los tests corren sobre el fuente, no sobre `dist` |
| **El `quoteId` firmado nunca era el guardado** | Los tests firmaban y verificaban el mismo objeto en memoria |
| Body vacío con Content-Type JSON → 500 | Ningún test mandaba esa combinación |
| El manejador de errores descartaba los 4xx ajenos | Ídem |
| **Signos invertidos en el ledger en efectivo** | El test afirmaba los valores del bug |
| El test comparaba ventanas de tiempo distintas | Coincidía por casualidad con un solo viaje |

Los dos en negrita eran de la capa de dinero. El de los signos pasaba el chequeo
de suma cero, porque **ambas** patas estaban invertidas — la suma cero es
necesaria pero no detecta una inversión simétrica.

Los nueve tienen ahora un test que los cubre. Pero el patrón vale más que los
arreglos: un test que afirma lo que la implementación devuelve, en vez de lo que
la especificación exige, congela el bug y da confianza falsa.

### Todavía sin verificar

- El emulador de Android: la app no existe.
- Mapbox: sin `MAPBOX_TOKEN` el ruteo es una estimación local, y la respuesta lo
  dice en `routeProvider`.
- Pagos: no hay integración con MercadoPago.
- Más de una instancia del API (ver la sección de límites).

## Estructura

```
orbit-rides/
├── packages/domain/          Lógica pura. Cero I/O. 76 tests.
│   ├── money.ts              Centavos enteros, redondeo bancario
│   ├── pricing.ts            Tarifas + cotización firmada con HMAC
│   ├── commission.ts         Comisión por plan + break-even
│   ├── trip-state.ts         Máquina de estados + política de cancelación
│   ├── dispatch.ts           Filtro de elegibilidad, scoring, olas
│   ├── ledger.ts             Doble entrada con invariante de suma cero
│   └── geo.ts                Haversine, rumbo, interpolación
├── services/api/
│   ├── migrations/           6 archivos SQL versionados
│   ├── src/
│   │   ├── config/           Validación con zod al arrancar
│   │   ├── auth/             Tokens; el rol sale de la base, no del token
│   │   ├── db/               Pool de Postgres, Redis (posiciones y locks)
│   │   ├── modules/          Repositorios y servicios por dominio
│   │   ├── http/             Rutas finas, schemas, manejo de errores
│   │   ├── ws/               Hub de WebSocket
│   │   └── workers/          Worker de dispatch
│   └── scripts/              migrate.ts, seed.ts
├── infra/k8s/                Manifests para más adelante (leé su README)
├── docs/                     Auditoría, arquitectura, modelo financiero
└── docker-compose.yml
```

---

## Decisiones que conviene conocer

**El servidor es autoritativo sobre tarifa, comisión y asignación.** El cliente
pide; el servidor decide. La cotización va firmada con HMAC y con vencimiento;
si el cliente manda un monto, se ignora. Es la corrección directa del problema
que tenía APTraslados, donde el gate de acceso vivía en el navegador y se
saltaba borrando un nodo del DOM.

**La comisión se congela al aceptar el viaje.** Si el conductor cambia de plan
a mitad de camino, la comisión de ese viaje no se mueve. Sin eso, la liquidación
no se puede defender frente a una disputa.

**El ledger es de doble entrada y las patas suman cero.** Se valida en el código
(`buildTransaction`) y otra vez en la base (constraint trigger diferido). Las
filas son inmutables por trigger: un error se corrige con un asiento de ajuste,
nunca editando el original.

**Las posiciones de los conductores no van a Postgres.** A un ping cada cuatro
segundos, 200 conductores son ~4,3 millones de escrituras diarias y el
autovacuum no da. Van a Redis con TTL: si un conductor deja de reportar, se cae
solo del índice y deja de recibir ofertas.

**Ofertas exclusivas por olas, no broadcast.** El broadcast es más fácil de
programar y premia al que tiene el reflejo más rápido mirando el celular
mientras maneja. La oferta exclusiva le da 15 segundos tranquilos al conductor
más conveniente.

**El scoring de dispatch tiene un término de equidad.** No es caridad: si el
ranking fuera solo cercanía y rating, los mismos cinco conductores se llevarían
todo y el resto se va en dos semanas. Perdés densidad de oferta, que es el
activo real del negocio.

**Las invariantes están en la base, no solo en el código.** Un conductor no
puede tener dos viajes activos, un pasajero no puede tener dos viajes abiertos,
una oferta aceptada por viaje, un plan activo por conductor. Son índices únicos
parciales: el código puede tener bugs, el motor no cede.

---

## Límites conocidos

Están documentados en el código, en el archivo donde importan.

1. **Una sola instancia del API.** El worker de dispatch usa timers en memoria.
   Con dos réplicas, ambas podrían despachar el mismo viaje — no corrompe datos
   (la base lo impide), pero duplica trabajo. Para escalar: BullMQ con
   `jobId = tripId`. Ver `infra/k8s/README.md`.

2. **El hub de WebSocket es en memoria.** Con varias réplicas hace falta un
   adapter de Redis pub/sub.

3. **`AUTH_MODE=firebase` no está implementado.** Está declarado y **rechaza
   todo** en vez de dejar pasar todo: si alguien despliega con ese modo sin
   completarlo, el servicio no autentica a nadie. Falla cerrado, a propósito.

4. **Sin token de Mapbox el ruteo es una estimación local** (línea recta × 1,3).
   La respuesta lo dice en `routeProvider`, así que un ETA estimado nunca se
   confunde con uno real. Poné `MAPBOX_TOKEN` en el compose para rutas de verdad.

5. **Pagos: no hay.** No hay MercadoPago, ni cobro de suscripciones, ni payouts.
   El ledger ya modela las tres operaciones; falta el conector del PSP.

6. **Sin surge.** El multiplicador está en el modelo y en la base, fijo en 1.0.
   Falta el cálculo de demanda por zona.

---

## Qué falta, en orden

1. **Correr el `docker compose up` y el `migrate` en tu máquina.** Es el primer
   paso real y es el que puede encontrar problemas que yo no pude ver.
2. **App de pasajero (Expo + React Native).** Login, mapa, destino, cotización,
   pedir, seguimiento en vivo por WebSocket.
3. **App de conductor.** Binario aparte: ubicación en background y foreground
   service son incompatibles con la app de pasajero en el mismo proceso.
4. **Tests de integración** contra Postgres y Redis reales, con Testcontainers.
5. **MercadoPago:** cobro en el viaje, suscripciones con dunning, payouts.
6. **Admin web.**

---

## Comandos

```powershell
npm run build       # compila dominio y API
npm test            # 129 tests
npm run smoke       # end-to-end contra el API levantado
npm run typecheck   # TypeScript estricto sin emitir
npm run migrate
npm run seed
npm run dev         # tsx watch
```

---

## Documentos

- `docs/01-auditoria-seguridad.md` — 10 hallazgos sobre el código de APTraslados
  que está en producción. El crítico: el paywall no protege nada.
- `docs/02-arquitectura-y-roadmap.md` — decisiones de stack, modelo de datos,
  roadmap por fases y riesgos ordenados.
- `docs/03-modelo-financiero.xlsx` — unit economics con fórmulas vivas. La
  conclusión: con comisión Pro al 2 %, un conductor Pro te deja **menos** que el
  mismo conductor en Free.
- `docs/04-prototipo-pasajero.html` — maqueta del flujo. Es una maqueta, no
  código de producción.

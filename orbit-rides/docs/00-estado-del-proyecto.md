# Orbit Rides — Estado del proyecto

**Última actualización:** 28/07/2026
**Punto de partida:** `APTraslados` 1.0.1 Beta, una PWA estática en producción
**Estado:** backend verificado de punta a punta. Las dos apps Android compilan y
corren; la de pasajero completó el flujo entero en el emulador, y a la de
conductor le queda un mapa que se ve negro.

Este documento es la bitácora completa: qué se analizó, qué se decidió, qué se
construyó, qué se rompió y por qué. Si alguien nuevo se suma al proyecto, esto es
lo primero que tiene que leer.

**Para poner el proyecto a andar en otra máquina, el documento es
[`../MIGRAR.md`](../MIGRAR.md).** Este de acá es el porqué; aquel es el cómo.

---

## 1. De dónde venimos

`APTraslados` es un sitio PWA estático que sigue en producción en
`aptraslados.web.app`. Es un brochure comercial de traslados en Uruguay más una
puerta de acceso para conductores, con suscripción de US$ 4,99/mes.

**Lo que había:**

| | |
|---|---|
| `index.html` | 707 líneas |
| `js/app.js` | 988 líneas |
| `js/session.js` | 1.466 líneas |
| `css/styles.css` | 1.827 líneas |
| Dependencias | ninguna, vanilla JS |
| Backend | **ninguno** — cero Cloud Functions, cero código de servidor |
| Infra | Firebase Hosting + Auth (solo Google) + Firestore |

Funcionaba: control de acceso por duración con trial de 15 días, panel admin con
otorgar/extender/vencer, countdown vivo por conductor, logs de acceso. El diseño
de esa gestión de accesos era bueno y se reusó conceptualmente en Orbit.

**La idea nueva:** competir con Uber por precio, monetizando con suscripción al
conductor en lugar de comisión alta. Planes propuestos: Free 12 %, Pro US$ 70 +
2 %, Plus US$ 150.

---

## 2. La auditoría de seguridad

Detalle completo en `01-auditoria-seguridad.md`. Resumen: **1 crítico, 4 altos,
5 medios, 3 bajos**.

Lo que estaba **bien hecho** —y merece decirse— era la ausencia total de XSS
(todos los `innerHTML` con plantillas estáticas y los datos por `textContent`),
un CSP restrictivo real, y reglas de Firestore con validación de esquema en vez
del clásico `allow read, write: if request.auth != null`.

**El crítico:** el paywall no protegía nada. `unlockDriver()` hacía
`showPinGate(false)`, que solo seteaba `gate.hidden = true`. Todo el contenido ya
venía en el `index.html` que Firebase Hosting sirve sin autenticación:

```
curl -s https://aptraslados.web.app/index.html
```

Eso devolvía la app completa. Se cobraba por un archivo que cualquiera descarga.

**Los altos:**

- Sin App Check: cualquiera podía crear cuentas contra Firestore desde un script.
- Admin hardcodeado a un email de Gmail, en el cliente **y** en las reglas.
- PIN de 4 dígitos con SHA-256 sin salt, y el propio conductor podía leer su hash.
- `config/app` guardaba los PINs de todos los conductores en texto plano.

**El diagnóstico de fondo:** ninguno de los hallazgos era descuido de
programación. Todos eran consecuencia de la misma decisión — **no había
servidor**. Una app sin backend puede ser un buen sitio de marketing, pero no
puede cobrar, ni autorizar, ni proteger.

---

## 3. El hallazgo financiero

Detalle en `03-modelo-financiero.xlsx`, con fórmulas vivas. Aritmética verificada
de forma independiente en Python: 81 de 81 celdas de la grilla de sensibilidad
coinciden.

**El resultado no fue el esperado.** No es que el plan Pro dé poco margen: **da
menos que el plan gratis.**

| Plan | Margen para la plataforma, por conductor/mes |
|---|---|
| Free · 12 % | **4.797 UYU** |
| Pro · US$ 70 + 2 % | **1.199 UYU** |
| Plus · US$ 150 + 0 % | **3.027 UYU** |

Cada conductor que compra el Pro deja 3.598 UYU/mes **menos** que el mismo
conductor en Free. Se estaría cobrando US$ 70 por el privilegio de ganar menos.

**La causa es aritmética simple.** Un viaje de $350 con tarjeta:

```
comisión al 2 %                    +$ 7,00
procesamiento (~3,5 % + $5)        -$17,25
mapas y soporte                    -$ 5,00
──────────────────────────────────────────
resultado por viaje                -$15,25
```

La suscripción alcanza a subsidiar 177 viajes de los 180 del supuesto mensual.
O sea que **el mejor cliente sería el que menos usa el producto** — un modelo
invertido.

**Dos umbrales, y confundirlos lleva a fijar mal el precio:**

| Umbral | Valor | Cuándo aplica |
|---|---|---|
| Comisión mínima para que un viaje **con tarjeta** no pierda | **6,36 %** | Si el conductor puede cobrar todo con tarjeta |
| Comisión mínima para que el viaje **promedio** no pierda | **4,39 %** | Para el P&L mensual, ponderado por el 60 % de tarjeta |

En la primera versión de este análisis di 4,39 % como "el mínimo por viaje". Era
impreciso: 4,39 % es el promedio ponderado, no el umbral por viaje con tarjeta.
Los tests del dominio lo detectaron y las dos funciones quedaron separadas
(`breakEvenCommissionBps` y `blendedBreakEvenCommissionBps`).

**Puntos de indiferencia para el conductor:**

| | Facturación mensual desde la que conviene |
|---|---|
| Free → Pro | US$ 700 (28.000 UYU) |
| Pro → Plus | **US$ 4.000** (160.000 UYU) |

Un conductor full-time en Montevideo factura del orden de US$ 1.500-2.500/mes.
El Plus exige más del doble de eso: **hoy ese plan no tiene mercado local.**

**Advertencia sobre las fuentes:** las tasas de procesamiento, la tarifa promedio
y la facturación del conductor son estimaciones, marcadas como tal en cada celda
del xlsx. Hay que confirmarlas con MercadoPago y con entrevistas reales antes de
tomar cualquier decisión de precio.

---

## 4. La arquitectura

Detalle en `02-arquitectura-y-roadmap.md`.

**El principio que ordena todo:** el servidor es autoritativo sobre tarifa,
comisión, asignación y dinero. El cliente pide; el servidor decide.

La razón es concreta: si el cliente calcula la tarifa, el conductor edita el
número. Si el cliente decide si la suscripción está vigente, la extiende gratis.
Si el cliente elige a quién le llega el viaje, se autoasigna los mejores.

### Stack

| Capa | Elección | Por qué |
|---|---|---|
| Backend | Node 22 + TypeScript + Fastify, monolito modular | Un lenguaje en todo el stack, tipos compartidos. Microservicios con equipo chico es suicidio operativo |
| Base | PostgreSQL 16 + PostGIS | Transaccional para dinero, geoespacial real. Firestore no hace queries por radio |
| Estado en vivo | Redis 7 | Últimas posiciones con TTL, locks de dispatch, rate limiting |
| Realtime | WebSocket | Un canal, control del backpressure. Los listeners de Firestore se pagan por lectura |
| Móvil | React Native + Expo | Un equipo, dos plataformas. Binarios separados para pasajero y conductor |

### Decisiones que conviene conocer

**La cotización va firmada con HMAC y con vencimiento.** El cliente manda un
`quoteId`; el servidor revalida firma y vigencia. Si el cliente manda un monto,
se ignora.

**La comisión se congela al aceptar el viaje.** Si el conductor cambia de plan a
mitad de camino, la comisión de ese viaje no se mueve. Sin eso, la liquidación no
se puede defender en una disputa.

**El ledger es de doble entrada y las patas suman cero.** Se valida en el código
y otra vez en la base con un constraint trigger diferido. Las filas son
inmutables por trigger: un error se corrige con un asiento de ajuste, nunca
editando.

**Las posiciones de conductor no van a Postgres.** A un ping cada 4 segundos, 200
conductores son ~4,3 millones de escrituras diarias y el autovacuum no da. Van a
Redis con TTL: si un conductor deja de reportar, se cae solo del índice.

**Ofertas exclusivas por olas, no broadcast.** El broadcast es más fácil de
programar y premia al que tiene el reflejo más rápido mirando el celular mientras
maneja. La oferta exclusiva le da 15 segundos tranquilos al más conveniente.

**El scoring de dispatch tiene un término de equidad.** No es caridad: si el
ranking fuera solo cercanía y rating, los mismos cinco conductores se llevarían
todo y el resto se va en dos semanas. Se pierde densidad de oferta, que es el
activo real.

**Las invariantes están en la base, no solo en el código.** Un conductor no puede
tener dos viajes activos, un pasajero no puede tener dos abiertos, una oferta
aceptada por viaje, un plan activo por conductor. Son índices únicos parciales: el
código puede tener bugs, el motor no cede.

---

## 5. Lo construido

```
orbit-rides/
├── packages/domain/        Lógica pura, cero I/O. 85 tests.
│   ├── money.ts            Centavos enteros, redondeo bancario half-even
│   ├── pricing.ts          Tarifas + cotización firmada con HMAC
│   ├── commission.ts       Comisión por plan + los dos umbrales de equilibrio
│   ├── trip-state.ts       Máquina de estados + política de cancelación
│   ├── dispatch.ts         Elegibilidad, scoring, planificación de olas
│   ├── ledger.ts           Doble entrada con invariante de suma cero
│   └── geo.ts              Haversine, rumbo, interpolación
├── services/api/           44 tests
│   ├── migrations/         7 archivos SQL, 540 líneas
│   └── src/
│       ├── config/         Validación con zod al arrancar
│       ├── auth/           El rol sale de la BASE, nunca del token
│       ├── db/             Pool de Postgres, Redis (posiciones y locks)
│       ├── modules/        Repositorios y servicios por dominio
│       ├── http/           Rutas finas, schemas, manejo de errores
│       ├── ws/             Hub de WebSocket
│       └── workers/        Worker de dispatch
├── apps/
│   ├── shared/             @orbit/client — cliente del API. 37 tests.
│   │   ├── errors.ts       Errores como clases distinguibles, no strings
│   │   ├── http.ts         fetch, Bearer, idempotencia, timeouts
│   │   ├── api.ts          Un método por endpoint
│   │   ├── ws.ts           WebSocket con backoff, jitter y watchdog
│   │   └── storage.ts      Token, inyectable
│   ├── rider/              App de pasajero: Login · Home · Quote · Tracking · Done
│   └── driver/             App de conductor: Login · Online · Offer · ActiveTrip
├── infra/k8s/              Manifests para más adelante
└── docs/                   Este documento y los cuatro análisis
```

**Números:** 81 archivos TypeScript, 10.059 líneas, 166 tests, 540 líneas de SQL.
Cero `any` explícitos, cero `@ts-ignore`. `tsconfig` con `strict`,
`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` y
`verbatimModuleSyntax`.

| | Archivos | Líneas |
|---|---|---|
| `packages/domain` | 16 | 1.950 |
| `services/api` | 34 | 4.029 |
| `apps/shared` | 10 | 1.316 |
| `apps/rider` | 11 | 1.379 |
| `apps/driver` | 10 | 1.385 |

### API

| Método | Ruta | Rol |
|---|---|---|
| GET | `/health`, `/health/ready` | público |
| POST | `/v1/auth/dev-login` | público (prohibido en producción por config) |
| GET | `/v1/me` | cualquiera |
| POST | `/v1/quotes` | pasajero |
| POST | `/v1/trips` | pasajero |
| GET | `/v1/trips/active` | cualquiera |
| GET | `/v1/trips/:id` | participante o staff |
| POST | `/v1/trips/:id/cancel` | participante |
| GET | `/v1/driver/offer` | conductor |
| POST | `/v1/trips/:id/accept`, `/reject`, `/arrived`, `/start`, `/complete` | conductor |
| POST | `/v1/driver/position` | conductor |
| GET | `/v1/driver/earnings` | conductor |
| GET | `/v1/admin/ledger/integrity`, `/v1/admin/trips/live` | admin |
| WS | `/v1/ws` | token por query string |

---

## 6. Mapas y ruteo sin tarjeta

Esto empezó con una pregunta tuya —«¿cuánto sale Maps?»— y terminó cambiando dos
decisiones.

**Google Maps son US$ 200/mes de crédito y después se paga.** Peor: el costo del
ruteo **escala con los intentos de dispatch, no con los viajes**. Cada ola de
ofertas consulta distancias. Un viaje que nadie acepta cuesta igual que uno que
sí. En una plataforma que arranca, donde la tasa de aceptación es baja
justamente porque hay pocos conductores, eso es un costo que crece cuando peor te
va.

Quedaron dos piezas, las dos gratis y sin API key:

| Pieza | Solución | Costo |
|---|---|---|
| Dibujar el mapa | **MapLibre** + tiles de un proveedor libre | 0 |
| Calcular rutas y matrices | **OSRM autohospedado** en Docker | 0 |

**MapLibre** es el fork libre de Mapbox GL, anterior al cambio de licencia. No
usa tokens: se le pasa una URL de estilo y listo. Si algún día hace falta un
proveedor pago, se cambia esa URL.

**OSRM** se levanta con el mapa de Uruguay de OpenStreetMap —413.586 nodos— y
responde tanto `/route` como `/table`, que es la matriz de distancias que el
dispatch necesita para ordenar candidatos. Verificado con una ruta real:
Pocitos → Ciudad Vieja, 5.705,5 m y 551 s. Sin límite de consultas, porque el
servidor es tuyo.

El ruteo está detrás de una interfaz con tres implementaciones en cascada: OSRM,
Mapbox si hubiera token, y una estimación local como último recurso. La respuesta
del API siempre dice cuál se usó, en `routeProvider`. Nunca se finge precisión
que no se tiene.

**Contrapartida honesta:** los proveedores de tiles libres son infraestructura
comunitaria. Sirven para desarrollar y para escala chica; para producción hay que
hospedar los propios o contratar. Y OSRM da distancias, no tráfico en vivo — para
un mercado como Montevideo alcanza, para São Paulo no alcanzaría.

---

## 7. Las apps Android

Dos binarios separados, `com.orbitrides.rider` y `com.orbitrides.driver`. Expo +
React Native + TypeScript.

**Un cliente compartido, dos capas de presentación.** `@orbit/client` concentra
red, errores, WebSocket y almacenamiento del token; si el contrato del servidor
cambia, se arregla en un lugar y el compilador señala los usos rotos en las dos
apps. En cambio `theme.ts`, `ui.tsx` y `OrbitMap.tsx` están **copiados a
propósito**: son presentación y van a divergir, porque el conductor necesita
botones más grandes y más contraste para usarse manejando. Compartirlos crearía
un acoplamiento que después hay que deshacer.

**Sin `react-navigation`.** El flujo es lineal y un `useState` con una unión
discriminada alcanza. Una dependencia menos es un problema menos.

**WebSocket más polling lento, las dos cosas.** El WebSocket solo no alcanza: si
se cae justo cuando el conductor acepta, el pasajero se queda mirando «buscando
conductor» para siempre. El polling solo se siente lento. Juntos, cada uno cubre
la debilidad del otro.

**Las dos restauran el viaje activo al abrir.** Sin eso, cerrar la app a mitad de
viaje te deja en un mapa vacío. Para el conductor es peor: no podría marcar
«llegué» ni cerrar el viaje, y quedaría colgado.

### Lo que funcionó en el emulador

La app de pasajero recorrió el flujo completo: login, mapa con tiles reales,
cotización firmada con su cuenta atrás, pedido, y los estados actualizándose. La
de conductor: login, el switch de en línea, reporte de posición y la pantalla de
ganancias mostrando la deuda en la dirección correcta.

### Lo que no

**El mapa de la app de conductor se ve negro.** Es el único frente abierto del
proyecto. Sé que el estilo carga —los handlers de MapLibre no reportan error— y
sé que en la app de pasajero el mismo componente sí dibujó. Probé cuatro
configuraciones de cámara distintas sin resolverlo, y tras el último cambio la
app dejó de abrir.

**Lo que hice mal acá fue adivinar en vez de aislar.** Cada intento cambiaba la
configuración completa y esperaba a ver. Lo que correspondía era un componente
MapLibre mínimo, de dos líneas, para saber primero si el problema es mi código o
el emulador. Eso es lo primero de la lista en `MIGRAR.md`, junto con todo lo
descartado, para que el próximo intento no repita el camino.

Y una alternativa que conviene tener presente: **el flujo entero funciona sin
mapa.** La cotización, el dispatch y la liquidación no dependen de él. Ponerlo
detrás de una bandera y seguir con pagos o notificaciones es una decisión
defendible.

### El bug que el emulador destapó

El conductor reportaba posición solo con `watchPositionAsync`, que avisa **cuando
se mueve**. Un conductor detenido esperando viajes —o sea, el caso normal— dejaba
de reportar, y a los 30 segundos vencía su entrada en Redis y desaparecía del
dispatch. Estaba en línea y no le llegaba nada.

El arreglo es un latido en intervalo fijo que reenvía la última posición conocida
aunque no haya cambiado. **Es un bug de producción**, del tipo que solo aparece
cuando alguien usa la app de verdad, y lo encontramos porque la corrimos.

### Dos trampas del emulador que costaron horas

**El emulador de Android arranca en Mountain View, California.** El conductor
reportaba esa posición, el dispatch busca en un radio de pocos kilómetros del
origen, y todos los viajes morían en `NO_DRIVERS` sin ninguna pista.
`adb emu geo fix -56.1601 -34.9089`, longitud primero.

**Dos apps con MapLibre abiertas tumban la GPU emulada.** `EGL_BAD_MATCH` y
frames de hasta 63 segundos. No es del código; en un teléfono real no pasa. Para
poder probar el dispatch con una sola app quedó `npm run ride`, un simulador de
pasajero por terminal que cotiza y pide un viaje contra el API real.

---

## 8. Los bugs, y por qué importan más que los arreglos

Esta es la sección más útil del documento.

### Encontrados por el compilador o los tests

| Bug | Detalle |
|---|---|
| Umbral de comisión mal etiquetado | Un test afirmó 636 bps donde yo esperaba 445. Tenía razón el test |
| `LOG_LEVEL` no aceptaba `silent` | Nivel válido de pino que dejé fuera del enum |
| `isUniqueViolation` sin sentido | Generé una cadena repetitiva de comparaciones. Reescrita |
| Constante de array en `INDEX` del xlsx | LibreOffice no la evalúa. Reemplazada por `IF` anidados |
| Referencia de celda equivocada | Apuntaba a `E11` en vez de `G9` |
| Un archivo suelto en el directorio de pruebas | Me lo avisó el compilador, no yo |

### Encontrados **solo al ejecutar**, con 110 tests verdes

Este es el punto. El typecheck estaba limpio y los tests pasaban. Nada de esto se
vio hasta que el sistema corrió de verdad.

| Bug | Por qué ningún test lo vio |
|---|---|
| `typecheck` con `tsc -b --dry` no construía nada | Nunca corrí el comando que documenté; usaba otro a mano |
| `npm test` fallaba en un clone limpio | Yo siempre compilaba antes |
| Enlaces de workspace no portables entre Linux y Windows | Instalé desde Linux en una carpeta de Windows |
| `.dockerignore` en la carpeta equivocada | No hay Docker en un test unitario |
| `packages/domain/node_modules` no existe (npm hoistea) | Ídem |
| `pino-pretty` es devDependency y la imagen no la tiene | Los tests corren con devDependencies |
| Ruta de migraciones rota en el layout compilado | Los tests corren sobre el fuente, no sobre `dist` |
| **El `quoteId` firmado nunca era el guardado** | Los tests firmaban y verificaban el mismo objeto en memoria |
| Body vacío con Content-Type JSON daba 500 | Ningún test mandaba esa combinación |
| El manejador de errores descartaba los 4xx ajenos | Ídem |
| **Signos invertidos en el ledger en efectivo** | El test afirmaba los valores del bug |
| El test comparaba ventanas de tiempo distintas | Coincidía por casualidad con un solo viaje |
| El hook de auth convertía 404 en 401 | Nadie pedía una URL inexistente en los tests |
| El healthcheck ahogaba el log con 50 líneas por minuto | No molesta hasta que necesitás depurar |

### Los dos de la capa de dinero

**La firma de la cotización no podía verificar nunca.** Se firmaba un
`randomUUID()` generado en JS y se dejaba que Postgres generara otro con
`DEFAULT gen_random_uuid()`. Al cliente se le devolvía el de la base. La firma
cubría un UUID que nadie veía. No era un caso borde: ese camino estaba roto al
100 %.

El arreglo fue en dos niveles, porque el id era solo el síntoma. Además de
insertar el id explícito, ahora se **guarda el JSON exacto que se firmó** y la
verificación es contra ese texto. Antes se reconstruía el payload desde las
columnas normalizadas, y eso era frágil por diseño: el surge vuelve como string
desde `NUMERIC`, y el `issuedAt` se deducía restando el TTL de la configuración —
o sea que cambiar `QUOTE_TTL_SECONDS` habría invalidado en silencio todas las
cotizaciones vivas. Ese segundo bug estaba armado esperando.

**Los signos del ledger estaban invertidos en efectivo.**

| | tarjeta | efectivo (roto) |
|---|---|---|
| `platform_revenue` | `-comisión` (haber = ingreso ganado) ✓ | `+comisión` (debe = ingreso **reducido**) ✗ |
| `driver_balance` | `-ganancia` (le debemos) ✓ | `-comisión` (le debemos lo que él nos debe) ✗ |

Tres cosas hacen esto peor que un bug común:

1. **La transacción sumaba cero**, así que el chequeo de integridad la aprobaba.
   La suma cero es necesaria pero **no detecta una inversión simétrica**.
2. **El test afirmaba los valores del bug.** Se escribió copiando lo que la
   implementación devolvía en vez de derivarlo de la contabilidad. Congeló el
   error y dio confianza falsa.
3. **En Uruguay el efectivo es el medio dominante**, así que la cuenta de
   ingresos habría quedado con el signo mal en la mayoría de los viajes.

Se agregaron chequeos de **dirección** (`platformRevenueEarnedCents`,
`driverOwedCents`), no solo de balance, y un test que construye a propósito una
transacción invertida para demostrar que pasa la suma cero y que el chequeo nuevo
sí la detecta.

### La lección

Un test que afirma **lo que la implementación devuelve**, en vez de **lo que la
especificación exige**, congela el bug y da confianza falsa. Y un test que mide
lo que es fácil de medir en vez de lo que importa —el saldo acumulado en vez del
delta de la operación— da falsos negativos apenas cambia el contexto.

Ninguna cantidad de tests verdes sustituye a ejecutar el sistema completo. Y lo
volvió a confirmar la etapa de las apps: el bug del latido de posición —el más
grave de todos, porque dejaba conductores invisibles para el dispatch— no lo
encontró ningún test. Lo encontró mirar un emulador.

Hay un segundo patrón que conviene nombrar, porque me pasó dos veces en la misma
sesión: **escribí scripts de verificación que daban falsos positivos.** Uno
revisaba los exports de `@orbit/client` y no contemplaba `export type { ... }`;
otro creía leer nombres de props y leía valores. Una verificación que no se
verifica a sí misma es peor que ninguna: da una confianza que no corresponde.

---

## 9. Qué está verificado

### Ejecutado de punta a punta

`npm run smoke` recorre 18 pasos contra Docker con PostGIS y Redis reales, y
pasa completo:

```
REQUESTED → MATCHING → ACCEPTED → ARRIVED → IN_PROGRESS → COMPLETED
tarifa $270,00 · comisión $5,40 (2 %, congelada) · conductor $264,60
el conductor nos debe $5,40 · delta exacto · ledger suma cero
```

Cuatro de esos pasos intentan romperlo a propósito y confirman que se rechaza:
reutilizar una cotización (409), que un segundo conductor tome el mismo viaje
(409), saltear estados (409), y que un pasajero entre al panel admin (403).

Las 7 migraciones se aplican contra PostGIS real, incluidos los triggers
diferidos del ledger, los triggers append-only y los índices únicos parciales.

### Suite automatizada

| Qué | Resultado |
|---|---|
| Dominio (`@orbit/domain`) | 85 tests |
| API (`@orbit/api`) | 44 tests |
| Cliente compartido (`@orbit/client`) | 37 tests |
| `tsc -b --force` estricto | 0 errores |
| Migraciones contra `libpg_query` | 7 archivos validan |
| YAML de Compose y k8s | 9 archivos validan |
| Modelo financiero | 81/81 celdas verificadas |
| `npm audit` | 0 vulnerabilidades |

### Corrido en el emulador

| Qué | Resultado |
|---|---|
| App de pasajero | Flujo completo: login, mapa, cotización, pedido, estados en vivo |
| App de conductor | Login, en línea, posición reportada, ganancias con el signo correcto |
| OSRM | Ruta real Pocitos → Ciudad Vieja: 5.705,5 m · 551 s |

### Sin verificar

- **El mapa de la app de conductor**: se ve negro, y tras el último cambio la app
  no abrió. Ver la sección 7 y `MIGRAR.md`.
- Cualquier teléfono real. Todo se probó en emulador.
- Pagos: no hay integración con ningún PSP.
- Más de una instancia del API.

---

## 10. Límites conocidos

Todos documentados en el código, en el archivo donde importan.

1. **Una sola instancia del API.** El worker de dispatch usa timers en memoria.
   Con dos réplicas, ambas podrían despachar el mismo viaje. No corrompe datos —
   la base lo impide con `trips_one_active_per_driver` y el `UPDATE` condicional
   de `assignDriver` — pero duplica trabajo. Para escalar: BullMQ con
   `jobId = tripId`.
2. **El hub de WebSocket es en memoria.** Con varias réplicas hace falta un
   adapter de Redis pub/sub.
3. **`AUTH_MODE=firebase` no está implementado.** Está declarado y **rechaza
   todo** en vez de dejar pasar todo. Falla cerrado, a propósito.
4. **Sin surge.** El multiplicador existe en el modelo y en la base, fijo en 1,0.
5. **Sin pagos, sin payouts, sin cobro de suscripciones.** El ledger ya modela
   las tres operaciones; falta el conector del PSP.
6. **Sin verificación de antecedentes, sin SOS, sin compartir viaje.**
7. **La ubicación del conductor es de primer plano.** Si minimiza la app deja de
   reportar y a los 30 segundos sale del índice de Redis. Arreglarlo requiere
   ubicación en background con foreground service, que en Android es la parte más
   peleada del desarrollo: cada fabricante mata procesos distinto. Merece su
   propia iteración con teléfonos reales, así que por ahora hay un cartel en la
   pantalla que se lo dice al conductor, en vez de fingir que funciona.
8. **El destino se elige de una lista fija** de ocho lugares de Montevideo. Lo que
   corresponde es un autocomplete contra un geocoder; se puede autohospedar
   Photon igual que OSRM, sin key.
9. **El login es de desarrollo:** botones con los teléfonos del seed. La config
   del backend prohíbe ese modo en producción. Lo que sigue es teléfono más OTP.
10. **Sin notificaciones push.** El conductor tiene que tener la app abierta para
    ver una oferta.

---

## 11. Qué sigue

### Inmediato

1. **Resolver el mapa negro**, empezando por aislarlo. Los pasos, en `MIGRAR.md`.
2. Notificaciones push con FCM: sin eso el conductor tiene que mirar la pantalla.
3. Tests de integración con Testcontainers contra Postgres y Redis reales.

### Antes de pensar en lanzar

Del roadmap (`02-arquitectura-y-roadmap.md`), la **fase 0** sigue pendiente y no
requiere código:

- Consulta legal y regulatoria: el transporte por app está regulado en
  Montevideo, y la **Ley 18.331** de protección de datos exige registro ante la
  URCDP, finalidad declarada y derechos de acceso, rectificación y supresión.
  Con geolocalización, el riesgo es mayor.
- Consulta de seguro: los seguros personales suelen excluir el transporte oneroso.
- **Verificar las tasas reales de MercadoPago Uruguay.** El modelo financiero
  entero pivotea sobre ese número y hoy es una estimación.
- 15 entrevistas a conductores y 15 a pasajeros. Si nadie paga US$ 70, mejor
  saberlo antes de construir la maquinaria de cobro.
- Cerrar precios con esos datos. Los planes actuales, según el modelo, destruyen
  margen.

### Riesgos ordenados por probabilidad de matar el proyecto

| Riesgo | Mitigación |
|---|---|
| **Arranque en frío de la oferta** | Lanzar en un barrio, no en la ciudad. Los conductores actuales de APTraslados son la semilla natural |
| Aritmética de los planes | Subir Pro a ~5-6 % y/o agregar fee de servicio al pasajero |
| Regulatorio | Consulta legal en fase 0, antes de escribir más código |
| Ubicación en background en Android | Dos semanas dedicadas. Probar en Xiaomi y Samsung reales |
| Un incidente de seguridad con un pasajero | Verificación de antecedentes antes del primer viaje, sin excepciones |
| Costo de mapas | **Resuelto:** MapLibre y OSRM autohospedado, sin costo por consulta |

---

## 12. Decisiones abiertas

1. **¿Mercado inicial es Montevideo o Punta del Este?** Punta tiene tickets más
   altos y estacionalidad; Montevideo, volumen constante y más competencia.
2. **¿El negocio de traslados actual se integra o queda separado?** Los viajes
   programados de aeropuerto tienen márgenes mucho mejores que el viaje urbano, y
   es una ventaja que Uber no tiene en ese corredor.
3. **¿Los conductores actuales son la semilla de la oferta?** Si ya hay relación
   con ellos, se resuelve parcialmente el riesgo número uno.
4. **¿Qué es el plan Plus si no es comisión más baja?** Prioridad en dispatch,
   seguro incluido, soporte dedicado. Hoy no tiene contenido y no tiene mercado.
5. **¿Presupuesto y horizonte?** Determina si la fase 1 es un MVP de validación o
   un lanzamiento comercial.

---

## Índice de documentos

Por dónde entrar según lo que necesites:

| Si querés… | Leé |
|---|---|
| **Ponerlo a andar en otra máquina** | `../MIGRAR.md` |
| Entender qué se hizo y por qué | Este documento |
| Correr el backend acá | `../README.md` |
| Compilar y probar las apps | `../apps/README.md` |
| Instalar Android Studio y el emulador | `../apps/SETUP-ANDROID.md` |

Y los análisis:

| Archivo | Qué contiene |
|---|---|
| `01-auditoria-seguridad.md` | 10 hallazgos sobre el código en producción, con plan de remediación |
| `02-arquitectura-y-roadmap.md` | Stack, modelo de datos, dispatch, pagos, roadmap por fases, riesgos |
| `03-modelo-financiero.xlsx` | Unit economics con fórmulas vivas y grilla de sensibilidad |
| `04-prototipo-pasajero.html` | Maqueta del flujo. Es una maqueta, no código de producción |
| `../infra/k8s/README.md` | Por qué Kubernetes todavía no |

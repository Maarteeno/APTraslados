# Continuar en otra máquina

Todo lo necesario para retomar el proyecto donde quedó.

---

## Actualización — 28/07/2026: la migración ya se hizo, y esto es lo que falló

El proyecto se movió a `C:\Proyectos\APTraslados` en una máquina nueva. El
backend corre: `npm run smoke` da **TODO OK, 18 pasos**. Pero el camino no fue
el que este documento prometía, y vale la pena dejarlo escrito.

### `git clone` NO alcanzaba: faltaba `services/api/scripts/`

El `.gitignore` de la raíz de APTraslados tenía esta regla:

```
scripts/
```

Sin barra inicial. En gitignore eso matchea **cualquier** carpeta llamada
`scripts` a cualquier profundidad. Estaba pensada para la carpeta del sitio PWA,
pero se llevó puesta `orbit-rides/services/api/scripts/`. Git la ignoró en
silencio: `git add orbit-rides` nunca la vio, y `migrate.ts`, `seed.ts`,
`smoke.ts` y `request-ride.ts` **nunca entraron al commit**.

Los síntomas no señalaban la causa:

- `docker compose up --build` fallaba en `test -f .../dist/scripts/migrate.js`
  con código 1 y **sin errores de TypeScript**. El guardián del Dockerfile hizo
  exactamente su trabajo: detectó que faltaba la salida esperada.
- `npm run smoke` daba `Cannot find module ...\scripts\smoke.ts`.

Ya está corregido: la regla ahora es `/scripts/`, y los archivos se recuperaron
copiándolos de la máquina anterior.

**Para verificar que no falta nada más**, en cualquier máquina de origen:

```powershell
git ls-files --others --ignored --exclude-standard orbit-rides
```

Todo lo que salga que no sea `node_modules`, `dist` o `*.tsbuildinfo` es
material que nunca llegó al repositorio.

### El test de rutas fallaba solo en Windows

`resourceDirCandidates` usa `resolve()`, que en Windows le antepone la unidad
actual a una ruta sin unidad: devuelve `C:\repo\...`. El test comparaba contra
`join(sep, ...)` → `\repo\...`. El código estaba bien; la expectativa asumía
POSIX. Se arregló normalizando el lado esperado con el mismo `resolve()`.

### No encadenes los comandos de Docker con `>>`

Postgres tarda unos segundos en quedar `healthy`. Si pegás toda la secuencia de
golpe, `migrate` y `seed` corren contra una base que todavía no acepta
conexiones y fallan con `ECONNREFUSED`. Después el smoke da
`relation "users" does not exist`, que parece otro problema y no lo es.

Corré `docker compose ps`, confirmá `healthy`, y recién ahí migrate y seed.

### El mapa negro del conductor: ya no pasa

En la máquina nueva **el mapa de la app de conductor dibuja bien**. No hubo que
tocar `OrbitMap.tsx`: el arreglo de cámara que ya estaba commiteado
—`initialViewState` fijo y los movimientos por el ref— era correcto, y lo que
fallaba era el entorno anterior. El AVD de esta máquina usa GPU por hardware
sobre una RTX 3090; el emulador viejo tiraba `EGL_BAD_MATCH`.

Vale la pena registrar el costo del método: se probaron cuatro configuraciones
de cámara adivinando, cuando el primer paso barato —un componente MapLibre
mínimo para separar "mi código" de "el entorno"— habría señalado el entorno en
diez minutos.

### El conductor no podía aceptar viajes, y el smoke decía TODO OK

`getTripDetail` solo autorizaba al pasajero, al conductor YA ASIGNADO y a staff.
Un conductor con oferta vigente todavía no es `trip.driver_id` —eso se asigna al
aceptar—, así que el `GET /v1/trips/:id` que hace la pantalla de oferta devolvía
403, la tarjeta quedaba en «Cargando el viaje…» y el botón Aceptar nunca se
habilitaba.

El smoke no lo veía porque llamaba a `/accept` directo, sin pasar por `getTrip`.
Mismo estado final, camino distinto al del cliente real. Ahora el smoke recorre
las mismas llamadas que hace la app, y verifica también que el permiso se apague
cuando la oferta se resuelve.

### Ruido de CRLF: resuelto de raíz

Se agregó `.gitattributes` en la raíz de APTraslados, no solo en `orbit-rides/`.
Los 19 archivos fantasma no deberían volver.

---

## 0. Antes de mover nada: limpiar el ruido de git

### Primero, un candado que dejé colgado

Un comando mío quedó a medias y dejó un archivo de bloqueo. Cualquier `git add`
o `git commit` va a fallar con *«Unable to create index.lock»* hasta que lo
borres. No tiene contenido, borrarlo es seguro:

```powershell
del /f C:\Users\gdelgado\Documents\GitHub\APTraslados\.git\index.lock
```

Mi culpa, y desde el sandbox no tengo permiso para borrarlo yo.

### Después, los 19 archivos "modificados"

`git status` en `APTraslados` muestra 19 archivos modificados que **nadie editó**.
Son solo cambios de fin de línea, CRLF por LF, producto de que los archivos
pasaron por un sistema Linux. Se confirma así:

```powershell
cd C:\Users\gdelgado\Documents\GitHub\APTraslados
git diff --ignore-all-space --stat        # no muestra nada = solo fin de línea
```

Si eso sale vacío, descartalos. **Antes verificá que no tengas trabajo tuyo sin
commitear** en esos archivos:

```powershell
git diff --stat                            # revisá la lista
git checkout -- .firebaserc .gitignore ADMIN.md css firebase.json firestore.rules index.html iniciar.bat js manifest.json publicar.bat sw.js backup
```

Eso deja `orbit-rides/` como el único cambio real, que es lo que querés commitear.

Agregué `orbit-rides/.gitattributes` para que no vuelva a pasar.

---

## 1. Mover el proyecto

**Con git, que es el camino recomendado:**

```powershell
cd C:\Users\gdelgado\Documents\GitHub\APTraslados
git add orbit-rides
git commit -m "Orbit Rides: backend, apps de pasajero y conductor, documentación"
git push
```

Y en la máquina nueva, `git clone` y listo.

**Si preferís copiar la carpeta**, no copies estas: son pesadas, se regeneran
solas, y algunas **rompen** en otra máquina.

| No copiar | Por qué |
|---|---|
| `node_modules/` | Los enlaces de workspace de npm **no son portables entre sistemas operativos**. Ya nos costó 18 errores de compilación en esta sesión |
| `apps/*/android/` | Lo regenera `expo prebuild` desde `app.json` |
| `apps/*/.expo/` | Caché del bundler |
| `packages/*/dist`, `services/*/dist` | Salida de compilación |
| `*.tsbuildinfo` | Caché incremental de TypeScript |
| `apps/*/.env` | Tiene la URL del API de *esta* máquina. Copiá desde `.env.example` |

Todas están en `.gitignore`, así que con git no hay que pensarlo.

---

## 2. Poner en marcha en la máquina nueva

En este orden. El primer paso no necesita nada instalado más que Node.

```powershell
# 1. Dependencias y verificación de la lógica — 2 segundos, sin Docker
cd <repo>\orbit-rides
npm install
npm run verify
#    Esperado: 85 tests en el dominio, 44 en el API, 37 en el cliente

# 2. Backend
docker compose up -d --build

# 3. Ruteo: una sola vez, unos minutos
docker compose --profile prepare up osrm-download osrm-build
docker compose up -d

# 4. Esquema y datos de prueba
docker compose exec api node services/api/dist/scripts/migrate.js
docker compose exec api node services/api/dist/scripts/seed.js

# 5. El flujo completo, automático
npm run smoke
#    Esperado: TODO OK, 18 pasos
```

Si `npm run smoke` da `TODO OK`, el backend está sano y podés ignorar todo lo
demás hasta que quieras tocar las apps.

**Para Android:** `apps/SETUP-ANDROID.md` tiene la instalación completa, y
`apps/README.md` cómo compilar y probar las apps. Las dos trampas del emulador
que ya pagamos:

```powershell
adb emu geo fix -56.1601 -34.9089    # sin esto el emulador está en California
adb shell am force-stop com.orbitrides.rider   # una app con mapa a la vez
```

---

## 3. Dónde quedó exactamente

### Funciona y está verificado ejecutándolo

| Qué | Evidencia |
|---|---|
| Backend completo de punta a punta | `npm run smoke`, 18 pasos, contra PostGIS y Redis reales |
| 166 tests automatizados | 85 dominio · 44 API · 37 cliente |
| 7 migraciones contra PostGIS | Triggers diferidos, append-only, índices únicos parciales |
| Ruteo con OSRM autohospedado | Uruguay: 413.586 nodos. Verificado con una ruta real |
| Ledger de doble entrada | Suma cero verificada, y la dirección de cada asiento |
| App de pasajero | **Login, mapa, cotización firmada, pedido y estados funcionaron en el emulador** |
| App de conductor | Login, online/offline, posición, ganancias con la deuda en la dirección correcta |

### No funciona

**El mapa de la app de conductor se ve negro**, y tras el último cambio la app no
abrió. Es el único frente abierto. Todo lo que aprendimos está abajo.

### Nunca se implementó

Pagos, notificaciones push, verificación de antecedentes, SOS, surge, panel de
administración web, ubicación en background del conductor.

---

## 4. El mapa negro: todo lo que sabemos

Lo dejo detallado porque el próximo intento debería arrancar informado, no de cero.

### Confirmado

- **El estilo carga.** Con los handlers `onDidFinishLoadingStyle` /
  `onDidFailLoadingMap` puestos, no aparece ningún cartel de error. No es red ni
  credenciales — MapLibre no usa API key.
- **En la app de pasajero el mapa SÍ dibujó** tiles reales en la pantalla de
  cotización, que usa `fitAll`.
- El emulador tira `EGL_BAD_MATCH` y frames de hasta 63 segundos con dos apps
  abiertas. Con una sola app el problema persiste, así que eso explica la
  degradación pero **no** el mapa negro.

### Lo que se intentó y por qué

1. `initialViewState` + `center`/`zoom` juntos → dos fuentes para la misma
   cámara. Descartado.
2. Solo `center`/`zoom` sin estado inicial → cámara sin posición definida.
   Descartado.
3. `initialViewState` siempre + movimientos por el ref → **este es el estado
   actual del código.**
4. Guarda para no tocar la cámara antes de `onDidFinishLoadingStyle`, porque
   llamar `jumpTo` sobre un mapa sin vista nativa puede tirar la app. **Este es
   el cambio menos probado, y es el principal sospechoso de que la app no abra.**

### Por dónde seguiría

**Primero: aislar.** Un componente mínimo, sin nada del proyecto:

```tsx
import { Map } from '@maplibre/maplibre-react-native';
export default () => <Map style={{ flex: 1 }} mapStyle="https://tiles.openfreemap.org/styles/liberty" />;
```

Si eso dibuja, el problema está en mi código y se avanza agregando de a una pieza.
Si no dibuja, el problema es el entorno o la librería, y no hay que seguir
tocando `OrbitMap.tsx`.

**Segundo: descartar el emulador.** Un teléfono Android por USB con depuración
activada. MapLibre en emuladores es notoriamente problemático y llevamos varias
señales de eso.

**Tercero: revertir el último cambio** si la app no abre. `git log` sobre
`apps/driver/src/components/OrbitMap.tsx` y volver al estado anterior, que al
menos arrancaba.

**Cuarto: probar con Graphics en Software** en el AVD. Te dije *Hardware* porque
MapLibre usa OpenGL, y para un teléfono real es correcto, pero en el emulador el
camino de GL por hardware es una emulación incompleta y SwiftShader suele ser más
completo aunque más lento. Mi consejo apuntaba al lado equivocado.

### Y una alternativa honesta

Si el mapa nativo sigue peleando, **el flujo entero funciona sin mapa**. La
cotización, el dispatch, las ofertas y la liquidación no dependen de él: en la app
de pasajero el destino ya se elige de una lista. Poner el mapa detrás de una
bandera y seguir con lo que falta —pagos, push— es una decisión defendible. Un
mapa lindo no vale postergar el cobro.

---

## 5. Lo que sigue sin resolver, y es más importante que el código

Del `docs/00-estado-del-proyecto.md`, sin cambios:

**Tu modelo de planes destruye margen.** Un conductor en Pro deja 3.598 UYU/mes
**menos** que el mismo conductor en el plan gratis, porque la comisión del 2 % no
cubre el costo de procesar el pago. Eso no se arregla programando.

Lo que hace falta, y nada de esto es código:

1. **Tasas reales de MercadoPago Uruguay.** El modelo entero pivotea sobre ese
   número y hoy es una estimación mía.
2. **15 entrevistas a conductores.** ¿Pagarían US$ 70/mes? ¿Cuánto facturan?
3. **Consulta legal:** transporte por app en Montevideo, y la Ley 18.331 de
   protección de datos con geolocalización.
4. **Consulta de seguro:** los seguros personales excluyen el transporte oneroso.
5. **Decidir los precios** con esos datos.

Y la decisión que más mueve el riesgo número uno, el arranque en frío:
**¿los conductores actuales de APTraslados son la semilla de la oferta?** Si ya
tenés relación con ellos, tenés algo que Uber no puede comprar.

---

## 6. Índice de documentos

| Archivo | Qué contiene |
|---|---|
| `README.md` | Cómo correr el backend, paso a paso |
| `MIGRAR.md` | Este documento |
| `docs/00-estado-del-proyecto.md` | Bitácora completa: decisiones, bugs y por qué se escapó cada uno |
| `docs/01-auditoria-seguridad.md` | 10 hallazgos sobre APTraslados en producción |
| `docs/02-arquitectura-y-roadmap.md` | Stack, modelo de datos, dispatch, roadmap, riesgos |
| `docs/03-modelo-financiero.xlsx` | Unit economics con fórmulas vivas |
| `docs/04-prototipo-pasajero.html` | Maqueta del flujo, no código de producción |
| `apps/SETUP-ANDROID.md` | Android Studio, SDK, emulador |
| `apps/README.md` | Compilar y probar las apps, con las trampas del emulador |
| `infra/k8s/README.md` | Por qué Kubernetes todavía no |

Los comentarios del código llevan el *por qué* de cada decisión, no el *qué*.
`packages/domain/src/ledger.ts` y `apps/*/src/components/OrbitMap.tsx` son los
dos que más vale leer antes de tocarlos.

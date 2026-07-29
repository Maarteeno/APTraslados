# Apps móviles

Dos binarios de Android: pasajero y conductor. Expo + React Native + TypeScript,
mapa con MapLibre (sin API key, sin tarjeta).

> **Antes de esto:** `SETUP-ANDROID.md` — Android Studio, SDK y emulador. Y el
> backend arriba (`docker compose ps` desde la raíz del repo).

---

## Estado honesto

Las dos apps compilan y corren en el emulador.

| Qué | Estado |
|---|---|
| App de pasajero | **Flujo completo verificado**: login, mapa con tiles reales, cotización firmada, pedido, estados en vivo |
| App de conductor | Login, en línea, reporte de posición y ganancias funcionan |
| Mapa de la app de conductor | **Se ve negro.** Es el único frente abierto |
| Cliente compartido `@orbit/client` | 37 tests, typecheck limpio |
| Teléfonos reales | Sin probar. Todo fue en emulador |

Sobre el mapa negro: el estilo carga —MapLibre no reporta error— y el mismo
componente sí dibuja en la app de pasajero. Probé cuatro configuraciones de
cámara sin resolverlo, y tras la última la app dejó de abrir. **El error de método
fue adivinar en vez de aislar.** Lo que corresponde, y es el primer paso en
`../MIGRAR.md`, es un componente MapLibre mínimo de dos líneas para saber si el
problema está en mi código o en el emulador.

---

## Arrancar

```powershell
cd C:\Users\gdelgado\Documents\GitHub\APTraslados\orbit-rides
npm install
```

Después, cada app:

```powershell
cd apps\rider
Copy-Item .env.example .env
npm run typecheck        # esperá errores la primera vez
npm run android          # compila e instala en el emulador
```

La primera compilación de Gradle tarda entre cinco y quince minutos. La segunda
es mucho más rápida.

Igual para `apps\driver`. Las dos pueden estar instaladas a la vez: tienen
nombres de paquete distintos (`com.orbitrides.rider` y `com.orbitrides.driver`).

### Poner el emulador en Montevideo — obligatorio

El emulador de Android se ubica por defecto en **Mountain View, California**. La
app de conductor reporta esa posición, el dispatch busca en un radio de pocos
kilómetros del origen del viaje, y todos los pedidos terminan en `NO_DRIVERS` sin
ninguna pista de la causa.

```powershell
adb emu geo fix -56.1601 -34.9089
```

**Longitud primero, latitud después** — la misma trampa que OSRM.

También se puede desde la interfaz del emulador: los tres puntos (⋯) →
*Location* → cargar las coordenadas → *Send*. Y ahí mismo se puede simular una
ruta en movimiento, útil para probar el seguimiento del conductor.

Confirmá que llegó al backend:

```powershell
docker compose exec postgres psql -U orbit -d orbit -c "SELECT u.full_name, ST_Y(position::geometry) AS lat, ST_X(position::geometry) AS lng, is_online FROM driver_last_position p JOIN users u ON u.id = p.driver_id;"
```

La app de conductor muestra sus coordenadas cuando está en línea, y avisa en rojo
si están fuera de la zona operativa.

**Cuidado con esa consulta:** `driver_last_position` es un SNAPSHOT. El dispatch
NO la usa — busca en el índice geo de **Redis**, que tiene TTL de 30 segundos. Un
conductor puede aparecer ahí en Montevideo y con `is_online = true`, y no existir
para el dispatch. Para ver el índice de verdad:

```powershell
docker compose exec redis redis-cli --scan --pattern "drivers:online:*"
docker compose exec redis redis-cli ZRANGE <la-clave-que-salio> 0 -1
docker compose exec redis redis-cli --scan --pattern "driver:pos:*"
```

Si la primera devuelve una clave pero la tercera está vacía, los conductores
figuran en el índice pero sus posiciones vencieron: dejaron de reportar.

### Una sola app a la vez en el emulador

MapLibre necesita un contexto OpenGL por instancia. Con las dos apps abiertas la
GPU emulada se cae:

```
EGL_emulation: eglMakeCurrent(1920): error 0x3009 (EGL_BAD_MATCH)
app_time_stats: avg=62954.27ms
```

Frames de 63 segundos. No es un problema del código —en un teléfono real no
pasa—, es el techo del emulador. Cerrá la que no estés usando:

```powershell
adb shell am force-stop com.orbitrides.rider
adb shell am force-stop com.orbitrides.driver
```

Para probar el dispatch sin dos apps, usá el simulador de pasajero:

```powershell
npm run ride                  # pide un viaje al aeropuerto
npm run ride -- --list        # otros destinos
```

Cotiza y pide un viaje contra el API real, y sigue el estado en la terminal. El
conductor queda solo en el emulador y la oferta le llega de verdad por WebSocket.

### Probar el flujo completo

Necesitás las dos apps corriendo. Con un solo emulador se puede, alternando:

1. **Conductor** → entrar como Adrián Pereda → activar el switch **En línea**
2. **Pasajero** → entrar como Gastón Delgado → elegir destino → **Pedir Orbit**
3. **Conductor** → aparece la oferta con cuenta atrás de 15 s → **Aceptar**
4. **Conductor** → Llegué → Pasajero a bordo → Terminar viaje
5. **Pasajero** → el estado se actualiza en vivo por WebSocket

Si el conductor no está en línea, todos los viajes terminan en `NO_DRIVERS`. Es
el error número uno al probar por primera vez.

---

## Estructura

```
apps/
├── shared/          @orbit/client — cliente del API. 37 tests.
│   ├── errors.ts    Traducción de errores a clases distinguibles
│   ├── http.ts      fetch, Bearer, idempotencia, timeouts
│   ├── api.ts       Un método por endpoint
│   ├── ws.ts        WebSocket con backoff, jitter y watchdog
│   ├── storage.ts   Token, inyectable
│   └── types.ts     Contrato con el backend
├── rider/           App de pasajero
│   ├── src/screens/ Login · Home · Quote · Tracking · Done
│   └── src/components/OrbitMap.tsx
└── driver/          App de conductor
    ├── src/screens/ Login · Online · Offer · ActiveTrip
    └── src/components/OrbitMap.tsx
```

El cliente compartido es lo que hace que las dos apps no dupliquen la capa de
red. Si el contrato del servidor cambia, se arregla en un solo lugar y el
compilador señala los usos rotos en ambas.

`theme.ts`, `ui.tsx` y `OrbitMap.tsx` están **copiados** en las dos apps, no
compartidos. Es deliberado: son componentes de presentación que van a divergir
—la app de conductor necesita botones más grandes y contraste más alto para
usarse manejando— y compartirlos crearía un acoplamiento que después hay que
deshacer.

---

## Decisiones que conviene conocer

**Sin `react-navigation`.** El flujo es lineal y un `useState` con una unión
discriminada alcanza. Una dependencia menos es un problema menos: navigation trae
gestos, contexto y configuración nativa que acá no hacen falta.

**El mapa está aislado en `OrbitMap.tsx`.** Las pantallas hablan con `props`, no
con el SDK. Cambiar a Google Maps o Mapbox es reescribir un archivo.

**Ambas apps restauran el viaje activo al abrir.** Sin eso, cerrar la app a mitad
de viaje te deja en el mapa vacío. Para el conductor es peor: no podría marcar
"llegué" ni cerrar el viaje, y el viaje quedaría colgado.

**WebSocket más polling lento, las dos cosas.** El WebSocket solo no alcanza: si
se cae justo cuando el conductor acepta, el pasajero se queda mirando "buscando
conductor" para siempre. El polling solo se siente lento. Juntos, cada uno cubre
la debilidad del otro.

**La cotización muestra su cuenta atrás.** El servidor la vence a los 120 s; sin
mostrarlo, el usuario pide el viaje, recibe un error incomprensible y no entiende
que solo tenía que pedir otra.

**Los errores de carrera del dispatch tienen mensaje propio.** Cuando otro
conductor toma el viaje primero, el servidor responde 409. La app dice «Otro
conductor tomó este viaje», no «error 409».

---

## Límites conocidos

**La ubicación del conductor es de primer plano.** Si minimiza la app deja de
reportar y a los 30 segundos desaparece del índice de Redis, así que no recibe
más viajes.

Arreglarlo requiere ubicación en background con foreground service. En Android
esa es la parte más peleada del desarrollo: cada fabricante mata procesos
distinto y Xiaomi y Huawei son los peores. Merece su propia iteración con pruebas
en dispositivos reales, así que está documentado en la propia pantalla —hay un
cartel que se lo dice al conductor— en vez de fingir que funciona.

**El destino se elige de una lista fija** de ocho lugares de Montevideo. En la
app real esto es un autocomplete contra un geocoder; se puede autohospedar Photon
igual que OSRM, sin key ni tarjeta.

**El login es de desarrollo:** botones con los teléfonos del seed. La
configuración del backend prohíbe ese modo en producción. Lo que sigue es
teléfono más OTP con Firebase Auth.

**Sin notificaciones push.** El conductor tiene que tener la app abierta para ver
una oferta. FCM es el paso siguiente y el AVD ya tiene Play Services para eso.

**Los proveedores de tiles libres son infraestructura comunitaria.** Sirven para
desarrollar y para escala chica. Para producción conviene hospedar los propios o
contratar un proveedor — y conviene verificar los términos vigentes del que uses.

---

## Si algo falla

| Síntoma | Causa |
|---|---|
| `Unable to resolve @orbit/client` | Metro no ve el monorepo. Está resuelto en `metro.config.js`; si aparece, corré `npm install` desde la raíz del repo, no desde la app |
| `Invalid hook call` | Dos copias de React. `disableHierarchicalLookup` en `metro.config.js` lo previene |
| `SDK location not found` | Falta `ANDROID_HOME`, o no reabriste PowerShell |
| `Network request failed` | Estás usando `localhost` en vez de `10.0.2.2` |
| `CLEARTEXT communication not permitted` | Falta reconstruir después de agregar `usesCleartextTraffic` |
| El mapa aparece en blanco | Sin red, o el servidor de tiles no responde. MapLibre no usa API key |
| Todos los viajes dan `NO_DRIVERS` | El conductor no está en línea |
| `Failed to resolve plugin` en el prebuild | Falta una dependencia que `app.json` referencia en `plugins` |

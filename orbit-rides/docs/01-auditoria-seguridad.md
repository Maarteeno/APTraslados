# Auditoría de seguridad — APTraslados 1.0.1 Beta

**Alcance:** código en producción (`aptraslados.web.app`) al 27/07/2026.
**Método:** revisión estática de `index.html`, `js/app.js`, `js/session.js`, `js/firebase-config.js`, `sw.js`, `firestore.rules`, `firebase.json`.
**Resumen:** 1 crítico, 4 altos, 5 medios, 3 bajos. Lo bueno primero, porque hay cosas bien hechas.

---

## Lo que está bien hecho

No es un repo descuidado. Antes de la lista de problemas, esto merece reconocimiento:

- **Sin XSS.** Todos los `innerHTML` usan plantillas estáticas y los datos del usuario entran por `textContent` (`session.js:1119`, `1218`, `1287`). Además hay `sanitizeText()` y `sanitizePhone()` en el camino de escritura (`session.js:71`, `95`). Esto es exactamente cómo se hace.
- **CSP real y restrictiva** en `firebase.json`, más `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy` y COOP. Muchos proyectos serios no llegan a esto.
- **Reglas de Firestore con validación de esquema**, no `allow read, write: if request.auth != null`. Se validan tipos, longitudes y claves permitidas (`pendingCreateKeys()`).
- **`accessLogs` guarda `pinHint` de 2 caracteres**, no el PIN completo. Alguien pensó en esto.
- **Service worker network-first para HTML/CSS/JS**, así que no vas a servir código viejo.

El problema no es la ejecución. Es el modelo: **estás cobrando por algo que el navegador no puede proteger.**

---

## CRÍTICO

### C-1 · El paywall no protege nada. Todo el contenido es público.

**Evidencia:** `session.js:356` — `unlockDriver()` hace `showPinGate(false)`, que en `showPinGate()` (`session.js:295`) solo setea `gate.hidden = true`. Todo el contenido de la app ya está en `index.html`, servido por Firebase Hosting sin autenticación.

```
curl -s https://aptraslados.web.app/index.html
```

Eso devuelve la app completa: paseos, traslados, contacto, precios, estructura. `js/app.js` y `js/session.js` también son públicos.

**Impacto:** cobrás US$ 4,99/mes por acceso a un archivo HTML que cualquiera descarga sin loguearse. El "gate" es una cortina delante de una puerta abierta. Un conductor con la cuenta vencida solo necesita abrir DevTools y borrar el nodo `#pin-gate` — o `document.body.classList.remove('pin-locked')` — para seguir usando todo.

Peor: `PeredaSession` está expuesto en `window` (`session.js:1459`), y `sessionStorage['pereda-driver-session']` es un JSON editable. Escribís `{"pin":"1234","name":"X","phone":"59899999999","uid":"..."}` a mano, recargás, y `getDriver()` (`session.js:261`) lo acepta sin verificar nada contra el servidor.

**Fix:** ningún gate de negocio puede vivir en el cliente. Dos caminos:
1. **Corto plazo (esta semana):** aceptar que el contenido de marketing es público — no tiene valor secreto — y mover el valor real (los datos que el conductor consume) a Firestore detrás de reglas que evalúen `accessUntil` **del lado del servidor**. Ejemplo de regla:
   ```
   function hasAccess() {
     return get(/databases/$(database)/documents/driverAccounts/$(request.auth.uid))
              .data.accessUntil > request.time;
   }
   match /premiumContent/{doc} { allow read: if hasAccess(); }
   ```
2. **Para Orbit Rides:** el gate va en la API. El cliente nunca decide si tiene acceso; pide un token con claims y el backend rechaza.

---

## ALTO

### A-1 · Sin App Check. Tu Firestore está abierto a cualquier script.

**Evidencia:** no aparece `appCheck` ni `ReCaptchaV3Provider` en ningún archivo. `js/firebase-config.js` publica la config (correcto, no es secreto), pero sin App Check no hay nada que distinga tu app de un script.

**Impacto:** cualquiera se loguea con una cuenta Google descartable y crea `driverAccounts/{uid}` — las reglas lo permiten (`firestore.rules:40`, `allow create: if isSelf(uid) && pendingCreateKeys()`). Automatizado: miles de solicitudes falsas inundan el panel "Solicitudes", te queman la cuota de Firestore y te generan costo real. No hay captcha, ni rate limit, ni límite por IP.

**Fix:** habilitar Firebase App Check con reCAPTCHA Enterprise en web y enforcement en Firestore + Auth. Es media hora de trabajo. **Para Orbit Rides es no negociable**: cuando hay dinero en juego, esto es la diferencia entre un marketplace y una piñata.

### A-2 · Identidad de admin hardcodeada en el cliente y en las reglas.

**Evidencia:**
- `js/firebase-config.js:12` → `window.PEREDA_ADMIN_EMAIL = 'malerovi2014@gmail.com'`
- `js/session.js:5` → mismo valor como fallback literal
- `firestore.rules:6` → `request.auth.token.email == 'malerovi2014@gmail.com'`

**Impacto:** el admin puede otorgar acceso, regenerar PINs, desactivar conductores y leer todos los logs. Todo eso depende de una única cuenta Gmail personal, sin 2FA obligatorio y sin registro de acciones administrativas. Si esa cuenta cae, cae el sistema entero. Y rotar el admin exige editar código, deployar hosting **y** deployar reglas — tres pasos manuales, cada uno con chance de quedar desincronizado.

Además publicás el mail del admin en un JS estático: es un blanco de phishing regalado.

**Fix:** Custom Claims. Un Cloud Function con privilegios setea `{ role: 'admin' }` en el token; las reglas chequean `request.auth.token.role == 'admin'`. El email sale del código. Y **loguear toda acción admin** en una colección `auditLog` que el propio admin no pueda borrar.

### A-3 · PIN de 4 dígitos con SHA-256 sin salt, y el conductor puede leer su propio hash.

**Evidencia:** `session.js:227` — `sha256()` es `crypto.subtle.digest('SHA-256', ...)` crudo, sin salt ni KDF. El hash vive en `driverAccounts/{uid}.pinHash`, y `firestore.rules:38` permite `allow get: if isAdmin() || isSelf(uid)` — el conductor lee su propio documento, hash incluido.

**Impacto:** 10.000 combinaciones posibles. Una tabla precomputada de los 10.000 SHA-256 se genera en menos de un segundo. El hash es reversible de inmediato. Un conductor puede además leer su propio `accessUntil` y `status`, lo que le dice exactamente qué falsificar en el cliente (ver C-1).

Sumado: **no hay rate limiting ni lockout** en `tryUnlockWithPin` (`session.js:634`). Nada frena intentos ilimitados.

**Fix:** el PIN de 4 dígitos como segundo factor solo funciona si su verificación es del lado del servidor con throttling. En Orbit Rides eliminá el PIN: Firebase Auth con teléfono/OTP como primario, y biometría del dispositivo para desbloqueo rápido. Si mantenés el PIN mientras tanto: verificación en Cloud Function, `scrypt`/`argon2` con salt, y bloqueo tras 5 intentos.

### A-4 · `config/app` guarda los PINs en texto plano.

**Evidencia:** `firestore.rules:60` obliga a que el doc tenga `driverPins`; `session.js:823` (`writeConfigPins`) escribe el array de PINs sin hashear. `session.js:614` y `761` lo leen.

**Impacto:** un solo documento de Firestore contiene los PINs vigentes de todos los conductores, en claro. Las reglas lo limitan al admin — pero eso significa que **comprometer la cuenta del A-2 entrega todos los PINs de una**. Y `adminPinHash` cae al literal `'legacy'` en varios caminos (`session.js:765`, `793`, `842`), o sea que ese campo no protege nada.

**Fix:** el índice de PINs no debería existir. La unicidad se resuelve con la colección `drivers/{pin}` que ya tenés (el ID del doc garantiza unicidad de forma natural). Borrá `driverPins` de `config/app`.

---

## MEDIO

### M-1 · La ruta "legacy" concede acceso infinito.

**Evidencia:** `session.js:133-142` — `remainingMs()` devuelve `Number.POSITIVE_INFINITY` si la cuenta no tiene `billingStatus`, `accessUntil`, `trialEndsAt` ni `subscribedUntil`. `session.js:156-163` — `subscriptionAllowsAccess()` devuelve `true` en ese mismo caso.

**Impacto:** toda cuenta creada antes de que existieran los campos de billing tiene acceso permanente y gratuito, y ninguna tarea de servidor las barre. Es fuga de ingresos silenciosa. El propio `ADMIN.md` lo documenta como intencional ("Cuentas antiguas... siguen pudiendo entrar"), pero no hay fecha de corte ni inventario de cuántas son.

**Fix:** migración única — asignar `accessUntil` explícito a toda cuenta sin él, y borrar la rama legacy del código. Un default de "acceso infinito" siempre acaba siendo el camino que alguien encuentra.

### M-2 · Generación de PIN con `Math.random()`.

**Evidencia:** `session.js:817` — `String(Math.floor(1000 + Math.random() * 9000))`.

**Impacto:** `Math.random()` no es criptográfico y su estado es parcialmente inferible en V8 observando salidas sucesivas. Como el admin genera varios PINs en la misma sesión, un observador de esa secuencia podría predecir los siguientes. Impacto real acotado (el PIN es segundo factor), pero es un patrón que no querés arrastrar a un sistema con pagos.

**Fix:** `crypto.getRandomValues(new Uint32Array(1))` con rechazo de módulo.

### M-3 · `accessLogs` acepta escrituras ilimitadas de cualquier usuario autenticado.

**Evidencia:** `firestore.rules:66` — `allow create: if request.auth != null && ...` valida forma, pero no cantidad.

**Impacto:** un usuario autenticado escribe millones de documentos de log. Costo de Firestore + panel de logs inutilizable. No hay rate limit ni TTL.

**Fix:** rate limit en Cloud Function o política TTL de Firestore (ej. 90 días) más un límite por uid y por día.

### M-4 · PII sin política de retención, sin aviso de privacidad, sin vía de borrado.

**Evidencia:** `accessLogs` guarda `name`, `phone`, `ua`, `uid`, `at` (`firestore.rules:66-79`). `driverAccounts` guarda nombre, teléfono, email, marca y modelo del vehículo. No hay política de privacidad en el repo ni link en `index.html`.

**Impacto:** en Uruguay la **Ley 18.331** de protección de datos personales te hace responsable de base de datos, con obligación de registro ante la URCDP, finalidad declarada, consentimiento y derecho de acceso/rectificación/supresión del titular. Hoy no hay ninguno de los cuatro. Con Orbit Rides sumás geolocalización — dato sensible por su granularidad — y el riesgo se multiplica.

**Fix:** política de privacidad y términos antes de escalar; TTL en logs; endpoint de borrado de cuenta; registro ante la URCDP. Esto es trabajo de abogado, no de dev, y conviene arrancarlo ya porque tiene plazos.

### M-5 · La sesión del cliente controla a dónde apuntan los QR de WhatsApp.

**Evidencia:** `session.js:247-258` guarda `{pin, name, phone, uid}` en `sessionStorage`; `app.js` construye los links `wa.me` con `driver.phone` desde `getDriver()`.

**Impacto:** editando `sessionStorage` se cambia el teléfono al que apuntan todos los QR de la app. Un atacante con acceso físico o vía XSS (hoy no hay, pero) redirige los leads de los clientes a su propio WhatsApp. Robo de leads silencioso.

**Fix:** derivar el teléfono siempre del documento de Firestore en cada render, no del storage local. Tratá `sessionStorage` como caché de UI, nunca como fuente de verdad.

---

## BAJO

### B-1 · `img-src 'self' data: https:` en el CSP permite cualquier imagen HTTPS
Reducir a los hosts que realmente usás. Con mapas vas a tener que ajustarlo igual.

### B-2 · `style-src 'unsafe-inline'`
Necesario hoy por los estilos inline. Migrar a clases o usar nonces cuando reescribas.

### B-3 · Fuentes de Google en la lista de precache del service worker
`sw.js:41` mete `fonts.googleapis.com` en `cache.addAll()`. Si falla esa red, **toda** la instalación del SW falla (`addAll` es atómico) y el usuario se queda sin modo offline. Además es una dependencia de terceros en el arranque. Autohospedá las fuentes.

---

## Plan de remediación

| # | Acción | Esfuerzo | Cuándo |
|---|---|---|---|
| A-1 | Habilitar App Check con enforcement | 1h | Esta semana |
| A-4 | Borrar `driverPins` de `config/app` | 2h | Esta semana |
| A-2 | Custom Claims para admin + `auditLog` | 1 día | Esta semana |
| M-1 | Migrar cuentas legacy y borrar la rama | 3h | Esta semana |
| M-2 | `crypto.getRandomValues` para PINs | 15min | Esta semana |
| M-5 | Teléfono desde Firestore, no storage | 2h | Este mes |
| M-3 | TTL + rate limit en `accessLogs` | 3h | Este mes |
| A-3 | Verificación de PIN en servidor con throttling | 2 días | Este mes |
| M-4 | Privacidad, términos, borrado, URCDP | Legal | Arrancar ya |
| C-1 | Gate real del lado del servidor | — | Se resuelve en la arquitectura de Orbit Rides |
| B-1/2/3 | Ajustes de CSP y precache | 1h | Cuando toques el archivo |

**Lectura de fondo:** ninguno de estos hallazgos es descuido de programación — el código está prolijo. Son todos consecuencia de la misma decisión: **no hay servidor.** Una app sin backend puede ser un buen sitio de marketing, pero no puede cobrar, ni autorizar, ni proteger. Es exactamente el límite que Orbit Rides obliga a cruzar.

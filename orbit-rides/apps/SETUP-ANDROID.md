# Preparar Android en Windows

Empezá por acá. Son descargas grandes, así que arrancalas ahora y seguí leyendo
mientras bajan.

**Tiempo real:** entre 40 minutos y dos horas, casi todo esperando descargas.
**Espacio en disco:** ~12 GB.

> **Las apps usan MapLibre, no Google Maps.** No hace falta cuenta de Google
> Cloud, ni API key, ni tarjeta. La sección 7 quedó como referencia por si algún
> día querés migrar a Google, pero **para arrancar salteala**.

---

## 1. Android Studio (~1 GB de instalador, ~8 GB instalado)

```powershell
winget install Google.AndroidStudio
```

Si `winget` falla, bajalo de https://developer.android.com/studio

Al abrirlo por primera vez:

1. Elegí **Standard** en el asistente de setup.
2. Aceptá las licencias del SDK (hay varias, todas).
3. Dejá que descargue. Son unos 3-4 GB más.

## 2. Componentes del SDK

En Android Studio: **More Actions → SDK Manager** (o `Tools → SDK Manager` si ya
tenés un proyecto abierto).

En la pestaña **SDK Platforms**, tildá:

- **Android 14.0 (UpsideDownCake) — API 34**

En la pestaña **SDK Tools**, tildá:

- Android SDK Build-Tools
- Android SDK Command-line Tools (latest)
- Android Emulator
- Android SDK Platform-Tools
- **Intel x86 Emulator Accelerator (HAXM)** — solo si aparece; en Windows 11
  moderno se usa WHPX y esta opción no está

Aplicá y esperá.

## 3. Virtualización

El emulador necesita virtualización por hardware. Verificá:

```powershell
systeminfo | Select-String "Hyper-V", "Virtualización"
```

Si dice que la virtualización está deshabilitada en el firmware, hay que
habilitarla en la BIOS/UEFI — reiniciás, entrás con F2/F10/Del según el
fabricante, y buscás **Intel VT-x** o **AMD-V**.

Y habilitá la plataforma de hipervisor de Windows:

```powershell
# PowerShell COMO ADMINISTRADOR
Enable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform -All
Enable-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform -All
```

Reiniciá después de esto.

## 4. Crear el emulador (AVD)

Android Studio → **More Actions → Virtual Device Manager → Create Device**.

| Campo | Valor | Por qué |
|---|---|---|
| Dispositivo | Pixel 7 | Tamaño de pantalla realista |
| System Image | **API 34, x86_64, con Google Play** | Para MapLibre no hace falta, pero sí para las notificaciones push (FCM) más adelante. Mejor tenerlo desde ahora que rearmar el AVD |
| RAM | 2048 MB o más | Con menos, el emulador se arrastra |
| Graphics | Hardware — GLES 2.0 | MapLibre renderiza con OpenGL: sin aceleración el mapa va a los tirones |

En la lista hay tres variantes por API. La que dice **"Google Play"** en la
columna *Target* es la que conviene.

Arrancá el emulador y dejalo abierto.

## 5. Variables de entorno

Sin esto, `expo run:android` no encuentra el SDK.

```powershell
# PowerShell normal, no hace falta admin
$sdk = "$env:LOCALAPPDATA\Android\Sdk"
[Environment]::SetEnvironmentVariable("ANDROID_HOME", $sdk, "User")
[Environment]::SetEnvironmentVariable("ANDROID_SDK_ROOT", $sdk, "User")

$rutas = @(
  "$sdk\platform-tools",
  "$sdk\emulator",
  "$sdk\cmdline-tools\latest\bin"
)
$actual = [Environment]::GetEnvironmentVariable("Path", "User")
foreach ($r in $rutas) {
  if ($actual -notlike "*$r*") { $actual = "$actual;$r" }
}
[Environment]::SetEnvironmentVariable("Path", $actual, "User")
```

**Cerrá y volvé a abrir PowerShell.** Después verificá:

```powershell
adb --version
emulator -list-avds
```

Si `adb` no responde, el `Path` no se aplicó: cerrá *todas* las ventanas de
PowerShell y abrí una nueva.

## 6. Java — hace falta, no es opcional

Android Studio trae su propio JDK, pero **Gradle no lo encuentra solo** cuando lo
invoca Expo desde la terminal. Sin `JAVA_HOME`, el build falla con:

```
ERROR: JAVA_HOME is not set and no 'java' command could be found in your PATH.
```

Este bloque busca el JDK entre las ubicaciones posibles, lo setea de forma
permanente y también en la sesión actual, así no hace falta reabrir PowerShell:

```powershell
$candidatos = @(
  "C:\Program Files\Android\Android Studio\jbr",
  "C:\Program Files\Android\Android Studio\jre",
  "$env:LOCALAPPDATA\Programs\Android Studio\jbr"
)
$jdk = $candidatos | Where-Object { Test-Path "$_\bin\java.exe" } | Select-Object -First 1

if (-not $jdk) {
  Write-Host "No encontré el JDK de Android Studio. Buscá la carpeta jbr a mano." -ForegroundColor Red
} else {
  [Environment]::SetEnvironmentVariable("JAVA_HOME", $jdk, "User")
  $env:JAVA_HOME = $jdk
  $env:Path = "$jdk\bin;$env:Path"
  Write-Host "JAVA_HOME = $jdk" -ForegroundColor Green
  java -version
}
```

La carpeta se llamó `jre` en versiones viejas y `jbr` (JetBrains Runtime) en las
actuales, y en algunas instalaciones cuelga de `LOCALAPPDATA`. Por eso se busca
en vez de hardcodear una ruta.

---

## 7. API key de Google Maps — OPCIONAL, no la necesitás

**Salteate esta sección.** Las apps usan MapLibre con tiles libres: sin key, sin
cuenta de Google Cloud, sin tarjeta.

Queda documentada por si en algún momento querés migrar a Google Maps. Si ese
día llega, tené en cuenta que **mostrar el mapa es gratis en los dos casos** — lo
que se paga son Directions, Geocoding y la matriz de ETA, y para esa última el
proyecto ya usa OSRM autohospedado, que es gratis y sin cuota.

<details>
<summary>Cómo sería con Google Maps (no hace falta hoy)</summary>

Es gratis para mostrar el mapa, pero Google pide una tarjeta asociada.

1. Entrá a https://console.cloud.google.com
2. Creá un proyecto: **Orbit Rides**
3. **APIs y servicios → Biblioteca**, buscá y habilitá:
   - **Maps SDK for Android**
4. **APIs y servicios → Credenciales → Crear credenciales → Clave de API**
5. Copiá la clave.

### Restringila antes de usarla

Una key sin restricciones que se filtre la puede usar cualquiera y el consumo te
lo cobran a vos. En la clave recién creada:

- **Restricciones de aplicación** → *Apps para Android*. Agregá el nombre del
  paquete (`com.orbitrides.rider` y `com.orbitrides.driver`) y la huella SHA-1 de
  tu certificado de debug:

  ```powershell
  keytool -list -v -keystore "$env:USERPROFILE\.android\debug.keystore" -alias androiddebugkey -storepass android -keypass android
  ```

  Copiá la línea `SHA1:`.

- **Restricciones de API** → solo *Maps SDK for Android*.

### Dónde va la key

En `orbit-rides/apps/rider/.env` y `orbit-rides/apps/driver/.env`:

```
GOOGLE_MAPS_API_KEY=AIza...
EXPO_PUBLIC_API_URL=http://10.0.2.2:8080
```

Los dos archivos `.env` están en `.gitignore`. **No commitees la key.** Hay
copias `.env.example` de referencia.

> **Sobre el costo:** las fuentes se contradicen sobre la estructura del tramo
> gratuito, así que si algún día activás esto, pasá tus volúmenes por la
> calculadora oficial y poné un **presupuesto con alerta** en Facturación antes
> de usar la key. Es cinco minutos y te evita una sorpresa.

</details>

---

## 8. Por qué `10.0.2.2` y no `localhost`

El emulador es una máquina virtual con su propia red. Su `localhost` es él
mismo, no tu PC. Android reserva `10.0.2.2` para apuntar al host.

| Desde dónde corre la app | URL del API |
|---|---|
| Emulador de Android | `http://10.0.2.2:8080` |
| Celular físico por USB o WiFi | `http://<IP-de-tu-PC>:8080` |
| Navegador en tu PC | `http://localhost:8080` |

Para el celular físico, tu IP:

```powershell
ipconfig | Select-String "IPv4"
```

Y el firewall de Windows tiene que dejar pasar el 8080:

```powershell
# COMO ADMINISTRADOR
New-NetFirewallRule -DisplayName "Orbit API 8080" -Direction Inbound `
  -LocalPort 8080 -Protocol TCP -Action Allow
```

---

## 9. Celular físico (alternativa al emulador)

Más rápido y te ahorra ~8 GB.

1. En el celular: **Ajustes → Información del teléfono**, tocá siete veces
   *Número de compilación*.
2. **Ajustes → Opciones de desarrollador → Depuración por USB**: activar.
3. Conectá por USB y aceptá el diálogo de autorización.
4. Verificá:

   ```powershell
   adb devices
   ```

   Tiene que aparecer tu dispositivo como `device`, no como `unauthorized`.

---

## Checklist antes de seguir

```powershell
node --version          # v22+
docker --version        # y Docker Desktop corriendo
adb --version           # platform-tools en el Path
emulator -list avds     # al menos un AVD
adb devices             # emulador arrancado o celular conectado
```

Y el backend arriba:

```powershell
cd C:\Users\gdelgado\Documents\GitHub\APTraslados\orbit-rides
docker compose ps
curl http://localhost:8080/health/ready
```

Cuando todo eso responda, seguí con `apps/README.md`.

---

## Problemas frecuentes

| Síntoma | Causa |
|---|---|
| `SDK location not found` | Falta `ANDROID_HOME`, o no reabriste PowerShell |
| `emulator: ERROR: x86 emulation currently requires hardware acceleration` | Virtualización deshabilitada en BIOS, o falta WHPX |
| El emulador arranca negro y no pasa nada | Cambiá Graphics a *Software* en la config del AVD |
| El mapa aparece en blanco o gris | Sin conexión, o el servidor de tiles no responde. MapLibre no necesita key, así que el problema es de red |
| `Network request failed` en la app | Estás usando `localhost` en vez de `10.0.2.2` |
| `CLEARTEXT communication not permitted` | Falta `usesCleartextTraffic` — ya está puesto en las apps, pero requiere reconstruir |
| Gradle tarda diez minutos la primera vez | Es normal. La segunda es mucho más rápida |

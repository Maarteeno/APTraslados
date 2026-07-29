# =====================================================================
#  Orbit Rides - Crea los dos emuladores Android (pasajero y conductor)
#
#  Requisito previo:  setup-dev.bat -Android
#                     (instala Android Studio y setea ANDROID_HOME / JAVA_HOME)
#
#  Uso:
#    setup-avds.bat                  -> crea Orbit_Rider y Orbit_Driver
#    setup-avds.bat -Force           -> los recrea si ya existen
#    setup-avds.bat -SoftwareGpu     -> renderizado por software (ver nota abajo)
#
#  Nota sobre -SoftwareGpu: el mapa de la app de conductor se ve negro y MapLibre
#  usa OpenGL. En emuladores el camino de GL por hardware es una emulacion
#  incompleta, y SwiftShader suele ser mas completo aunque mas lento. Si el mapa
#  sigue negro con GPU por hardware, recrea los AVD con este switch.
# =====================================================================

param(
    [switch]$Force,
    [switch]$SoftwareGpu
)

$ErrorActionPreference = 'Continue'

$ApiLevel  = 34
$ImageId   = "system-images;android-$ApiLevel;google_apis_playstore;x86_64"
$DeviceId  = 'pixel_7'
$Avds      = @(
    @{ Name = 'Orbit_Rider';  Label = 'Pasajero  (com.orbitrides.rider)' },
    @{ Name = 'Orbit_Driver'; Label = 'Conductor (com.orbitrides.driver)' }
)

function Write-Step($m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }
function Write-Ok($m)   { Write-Host "  [OK]    $m" -ForegroundColor Green }
function Write-Warn2($m){ Write-Host "  [!]     $m" -ForegroundColor Yellow }
function Write-Err2($m) { Write-Host "  [FALLO] $m" -ForegroundColor Red }

Write-Host ""
Write-Host "  Orbit Rides - emuladores Android" -ForegroundColor Magenta

# ---------------------------------------------------------------------
Write-Step "1. Ubicando el SDK"

$sdk = $env:ANDROID_HOME
if (-not $sdk) { $sdk = [Environment]::GetEnvironmentVariable('ANDROID_HOME','User') }
if (-not $sdk) { $sdk = "$env:LOCALAPPDATA\Android\Sdk" }

if (-not (Test-Path $sdk)) {
    Write-Err2 "No encontre el SDK de Android en: $sdk"
    Write-Host "         Corre primero:  setup-dev.bat -Android" -ForegroundColor DarkGray
    Write-Host "         y abri Android Studio una vez para que baje el SDK." -ForegroundColor DarkGray
    Read-Host "Enter para salir"
    exit 1
}
Write-Ok "SDK: $sdk"

$sdkmanager  = Join-Path $sdk 'cmdline-tools\latest\bin\sdkmanager.bat'
$avdmanager  = Join-Path $sdk 'cmdline-tools\latest\bin\avdmanager.bat'
$emulatorExe = Join-Path $sdk 'emulator\emulator.exe'

if (-not (Test-Path $sdkmanager)) {
    Write-Err2 "Falta cmdline-tools. En Android Studio: SDK Manager -> SDK Tools ->"
    Write-Host "         'Android SDK Command-line Tools (latest)'. Instalalo y volve." -ForegroundColor DarkGray
    Read-Host "Enter para salir"
    exit 1
}
Write-Ok "cmdline-tools presente"

if (-not $env:JAVA_HOME) {
    $jdk = @(
        "C:\Program Files\Android\Android Studio\jbr",
        "C:\Program Files\Android\Android Studio\jre",
        "$env:LOCALAPPDATA\Programs\Android Studio\jbr"
    ) | Where-Object { Test-Path "$_\bin\java.exe" } | Select-Object -First 1
    if ($jdk) { $env:JAVA_HOME = $jdk; Write-Ok "JAVA_HOME = $jdk" }
    else { Write-Warn2 "Sin JAVA_HOME. sdkmanager puede fallar. Ver apps/SETUP-ANDROID.md seccion 6." }
}

# ---------------------------------------------------------------------
Write-Step "2. Licencias del SDK"
# sdkmanager --licenses pregunta una por una; le mandamos "y" de sobra.
$si = 1..30 | ForEach-Object { 'y' }
$si | & $sdkmanager --licenses --sdk_root="$sdk" 2>&1 | Out-Null
Write-Ok "licencias aceptadas"

# ---------------------------------------------------------------------
Write-Step "3. Componentes del SDK"
Write-Host "  Descarga grande la primera vez (imagen de sistema ~1.5 GB)..." -ForegroundColor DarkGray
& $sdkmanager --sdk_root="$sdk" `
    'platform-tools' `
    'emulator' `
    "platforms;android-$ApiLevel" `
    'build-tools;34.0.0' `
    $ImageId
if ($LASTEXITCODE -eq 0) { Write-Ok "componentes instalados" }
else { Write-Err2 "sdkmanager devolvio $LASTEXITCODE. Revisa el detalle arriba." }

# ---------------------------------------------------------------------
Write-Step "4. Creando los AVD"

# @(...) fuerza array: con un solo AVD, avdmanager devuelve un string suelto y
# `-contains` sobre un string compara el string entero, no sus elementos.
$existing = @(& $avdmanager list avd -c 2>$null)

function Set-AvdOption($iniPath, $key, $value) {
    if (-not (Test-Path $iniPath)) { return }
    $lines = @(Get-Content $iniPath | Where-Object { $_ -notmatch "^\s*$([regex]::Escape($key))\s*=" })
    $lines += "$key=$value"
    Set-Content -Path $iniPath -Value $lines -Encoding ASCII
}

foreach ($avd in $Avds) {
    $name = $avd.Name

    if ($existing -contains $name) {
        if ($Force) {
            Write-Warn2 "$name ya existe, se recrea (-Force)"
            & $avdmanager delete avd -n $name 2>&1 | Out-Null
        } else {
            Write-Ok "$name ya existe (usa -Force para recrearlo)"
            continue
        }
    }

    Write-Host "  Creando $name ..." -ForegroundColor White
    # El "no" responde a "Do you wish to create a custom hardware profile?"
    'no' | & $avdmanager create avd -n $name -k $ImageId -d $DeviceId --force 2>&1 | Out-Null

    $ini = Join-Path $env:USERPROFILE ".android\avd\$name.avd\config.ini"
    if (-not (Test-Path $ini)) {
        Write-Err2 "$name no se creo. Revisa que la imagen $ImageId este instalada."
        continue
    }

    Set-AvdOption $ini 'hw.ramSize'              '2048'
    Set-AvdOption $ini 'vm.heapSize'             '512'
    Set-AvdOption $ini 'disk.dataPartition.size' '6G'
    Set-AvdOption $ini 'hw.gpu.enabled'          'yes'
    Set-AvdOption $ini 'hw.gpu.mode'             $(if ($SoftwareGpu) { 'swiftshader_indirect' } else { 'host' })
    Set-AvdOption $ini 'hw.keyboard'             'yes'
    # Montevideo por defecto. Sin esto el emulador arranca en California y todos
    # los pedidos terminan en NO_DRIVERS sin ninguna pista de la causa.
    Set-AvdOption $ini 'hw.gps'                  'yes'
    Set-AvdOption $ini 'avd.ini.displayname'     $name

    Write-Ok "$name creado - $($avd.Label)"
}

# ---------------------------------------------------------------------
Write-Step "5. Resumen"
$final = @(& $avdmanager list avd -c 2>$null)
foreach ($avd in $Avds) {
    if ($final -contains $avd.Name) { Write-Ok "$($avd.Name)" }
    else { Write-Err2 "$($avd.Name) NO existe" }
}

$gpuLabel = if ($SoftwareGpu) { 'software (SwiftShader)' } else { 'hardware (host)' }
Write-Host ""
Write-Host "  GPU configurada: $gpuLabel" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Arrancar los dos (cada uno en su ventana de PowerShell):" -ForegroundColor Yellow
Write-Host "    emulator -avd Orbit_Rider"
Write-Host "    emulator -avd Orbit_Driver"
Write-Host ""
Write-Host "  Ubicarlos en Montevideo - OBLIGATORIO, longitud primero:" -ForegroundColor Yellow
Write-Host "    adb devices                                        # ve los seriales"
Write-Host "    adb -s emulator-5554 emu geo fix -56.1601 -34.9089"
Write-Host "    adb -s emulator-5556 emu geo fix -56.1601 -34.9089"
Write-Host ""
Write-Host "  Instalar las apps (con el backend arriba):" -ForegroundColor Yellow
Write-Host "    cd orbit-rides\apps\rider  ; npm run android"
Write-Host "    cd orbit-rides\apps\driver ; npm run android"
Write-Host ""
Read-Host "Presiona Enter para salir"

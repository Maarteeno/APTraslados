# =====================================================================
#  GUARDAR SIEMPRE COMO UTF-8 **CON BOM**.
#
#  Windows PowerShell 5.1 lee los .ps1 sin BOM como CP1252, no como UTF-8.
#  Con eso, cada caracter multibyte se parte en varios y alguno cae en un
#  byte que CP1252 mapea a comilla tipografica:
#
#      -> (U+2192)  =  E2 86 92   y el 0x92 es " ' " (comilla derecha)
#      - (U+2500)   =  E2 94 80   y el 0x94 es " " " (comilla doble derecha)
#
#  PowerShell trata esas comillas como delimitadores de string. El parser
#  abre strings donde hay guiones de separador, se pierde, y falla con
#  "Falta la llave de cierre" senalando una funcion que esta perfecta.
#
#  Sintoma tipico: un error de llaves en la ULTIMA funcion del archivo,
#  mientras el conteo de llaves da balanceado. Si pasa, revisar el BOM antes
#  que la sintaxis.
# =====================================================================

# =====================================================================
#  Orbit Rides — orquestador de desarrollo
#
#    .\orbit.ps1 <comando>
#
#  Comandos:
#    up           Levanta el backend, migra y siembra si hace falta
#    down         Baja los contenedores (los datos sobreviven)
#    check        Typecheck y todos los tests. No toca nada.
#    api          Reconstruye el API, migra y corre el smoke
#    emu          Arranca los dos emuladores y los ubica en Montevideo
#    apps         Reinstala y reinicia las dos apps
#    dev          up + check + api + apps. El ciclo completo.
#    status       Qué está corriendo y en qué versión
#    release      Sube la versión, verifica todo, commitea, taguea y pushea
#                   .\orbit.ps1 release patch|minor|major
#
#  Modificadores:
#    -SkipTests   Saltea los tests donde se pueda (NO en release)
#    -Fresh       En `up`, borra los volúmenes y arranca de cero
#    -Yes         No pregunta nada
# =====================================================================

param(
    [Parameter(Position = 0)][string]$Command = 'help',
    [Parameter(Position = 1)][string]$Arg = '',
    [switch]$SkipTests,
    [switch]$Fresh,
    [switch]$Yes
)

$ErrorActionPreference = 'Continue'
$Root = $PSScriptRoot

# El AVD de cada app. Expo identifica los emuladores por NOMBRE DE AVD, no por
# el serial de adb: pasarle "emulator-5556" falla con "Could not find device".
$Apps = @(
    @{ Name = 'rider';  Avd = 'Orbit_Rider';  Package = 'com.orbitrides.rider';  Port = 8081 },
    @{ Name = 'driver'; Avd = 'Orbit_Driver'; Package = 'com.orbitrides.driver'; Port = 8082 }
)

# Montevideo. OJO: longitud primero, latitud después — igual que OSRM.
$GeoLng = '-56.1601'
$GeoLat = '-34.9089'

# ── salida ───────────────────────────────────────────────────────────────────
function Write-Step($m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }
function Write-Ok($m)   { Write-Host "  [OK]    $m" -ForegroundColor Green }
function Write-Warn2($m){ Write-Host "  [!]     $m" -ForegroundColor Yellow }
function Write-Err2($m) { Write-Host "  [FALLO] $m" -ForegroundColor Red }
function Write-Dim($m)  { Write-Host "          $m" -ForegroundColor DarkGray }

function Stop-Here($m) {
    Write-Err2 $m
    Write-Host ""
    exit 1
}

function Test-Cmd($n) { [bool](Get-Command $n -ErrorAction SilentlyContinue) }

function Sync-Path {
    $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' +
                [Environment]::GetEnvironmentVariable('Path','User')
}

# ── requisitos ───────────────────────────────────────────────────────────────
function Assert-Tools([string[]]$needed) {
    Sync-Path
    foreach ($t in $needed) {
        if (-not (Test-Cmd $t)) {
            Stop-Here "falta '$t' en el PATH. Corré setup-dev.bat y abrí una terminal nueva."
        }
    }
}

function Assert-DockerRunning {
    docker info 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Stop-Here 'Docker no responde. Abrí Docker Desktop y esperá a que diga "Engine running".'
    }
}

# ── backend ──────────────────────────────────────────────────────────────────

function Invoke-Up {
    Assert-Tools @('docker')
    Assert-DockerRunning
    Push-Location $Root

    if ($Fresh) {
        Write-Step 'Borrando volúmenes (-Fresh)'
        Write-Warn2 'esto elimina la base de datos y el grafo de OSRM'
        if (-not $Yes) {
            $answer = Read-Host '  Escribí "si" para confirmar'
            if ($answer -ne 'si') { Pop-Location; Stop-Here 'cancelado' }
        }
        docker compose down -v | Out-Null
        Write-Ok 'volúmenes borrados'
    }

    Write-Step 'Levantando el backend'
    docker compose up -d
    if ($LASTEXITCODE -ne 0) { Pop-Location; Stop-Here 'docker compose up falló' }

    # ── El paso que más tiempo hace perder si falta ──
    #
    # Postgres tarda unos segundos en aceptar conexiones. Sin esta espera,
    # migrate y seed corren contra una base que todavía no está y fallan con
    # ECONNREFUSED; después el smoke muere con «relation "users" does not
    # exist», que parece otro problema y no lo es.
    Write-Step 'Esperando a que Postgres esté healthy'
    $ready = $false
    foreach ($i in 1..60) {
        $state = (docker inspect orbit-postgres --format '{{.State.Health.Status}}' 2>$null)
        if ($state -eq 'healthy') { $ready = $true; break }
        Start-Sleep -Seconds 1
    }
    if (-not $ready) { Pop-Location; Stop-Here 'Postgres no llegó a healthy en 60 s. Mirá: docker compose logs postgres' }
    Write-Ok 'Postgres listo'

    # ── Datos de OSRM ──
    #
    # Se detecta por el healthcheck: si el motor no tiene el grafo preparado, el
    # entrypoint se queda esperando y el contenedor nunca pasa a healthy.
    $osrm = (docker inspect orbit-osrm --format '{{.State.Health.Status}}' 2>$null)
    if ($osrm -ne 'healthy') {
        Write-Warn2 'OSRM sin datos preparados: se construye el grafo (una sola vez, unos minutos)'
        docker compose --profile prepare up osrm-download osrm-build
        docker compose up -d osrm
        Write-Ok 'grafo de Uruguay construido'
    } else {
        Write-Ok 'OSRM con datos'
    }

    Write-Step 'Migraciones'
    docker compose exec -T api node services/api/dist/scripts/migrate.js
    if ($LASTEXITCODE -ne 0) { Pop-Location; Stop-Here 'las migraciones fallaron' }

    # Sembrar solo si no hay usuarios: el seed no es idempotente y volver a
    # correrlo sobre datos existentes deja el estado a medias.
    $users = (docker compose exec -T postgres psql -U orbit -d orbit -tAc 'SELECT count(*) FROM users' 2>$null)
    $count = if ($users) { "$users".Trim() } else { '' }
    if ($count -eq '0') {
        Write-Step 'Sembrando datos de prueba'
        docker compose exec -T api node services/api/dist/scripts/seed.js
    } elseif ($count -eq '') {
        Write-Warn2 'no se pudo contar usuarios; sembrá a mano si el login falla'
        Write-Dim 'docker compose exec api node services/api/dist/scripts/seed.js'
    } else {
        Write-Ok "ya hay $count usuarios, no se siembra"
    }

    Pop-Location
    Write-Ok 'backend arriba'
}

function Invoke-Down {
    Assert-Tools @('docker')
    Push-Location $Root
    Write-Step 'Bajando contenedores'
    docker compose down
    Pop-Location
    Write-Ok 'listo (los volúmenes quedan: usá -Fresh en up para borrarlos)'
}

function Invoke-Check {
    Assert-Tools @('npm')
    Push-Location $Root
    Write-Step 'Typecheck y tests'
    npm run verify
    $code = $LASTEXITCODE
    Pop-Location
    if ($code -ne 0) { Stop-Here 'verify falló: no sigas hasta arreglarlo' }
    Write-Ok 'todo verde'
}

function Invoke-Api {
    Assert-Tools @('docker', 'npm')
    Assert-DockerRunning
    Push-Location $Root

    Write-Step 'Reconstruyendo el API'
    docker compose build api
    if ($LASTEXITCODE -ne 0) { Pop-Location; Stop-Here 'el build del API falló' }

    docker compose up -d api
    if ($LASTEXITCODE -ne 0) { Pop-Location; Stop-Here 'no se pudo levantar el API' }

    # El contenedor arranca antes de estar listo para responder.
    Write-Step 'Esperando al API'
    $ready = $false
    foreach ($i in 1..45) {
        try {
            $r = Invoke-WebRequest -Uri 'http://localhost:8080/health/ready' -TimeoutSec 2 -UseBasicParsing
            if ($r.StatusCode -eq 200) { $ready = $true; break }
        } catch { }
        Start-Sleep -Seconds 1
    }
    if (-not $ready) { Pop-Location; Stop-Here 'el API no respondió. Mirá: docker compose logs api' }
    Write-Ok 'API respondiendo'

    Write-Step 'Migraciones'
    docker compose exec -T api node services/api/dist/scripts/migrate.js
    if ($LASTEXITCODE -ne 0) { Pop-Location; Stop-Here 'las migraciones fallaron' }

    if (-not $SkipTests) {
        Write-Step 'Prueba de humo'
        npm run smoke
        $code = $LASTEXITCODE
        Pop-Location
        if ($code -ne 0) { Stop-Here 'el smoke falló: el backend no está sano' }
        Write-Ok 'flujo completo verificado'
        return
    }

    Pop-Location
    Write-Warn2 'smoke salteado (-SkipTests)'
}

# ── emuladores ───────────────────────────────────────────────────────────────

function Get-RunningAvds {
    $out = @()
    $devices = @(adb devices 2>$null | Select-String -Pattern '^emulator-\d+' | ForEach-Object { ($_ -split '\s+')[0] })
    foreach ($serial in $devices) {
        $name = (adb -s $serial emu avd name 2>$null | Select-Object -First 1)
        if ($name) { $out += [pscustomobject]@{ Serial = $serial; Avd = $name.Trim() } }
    }
    return $out
}

function Invoke-Emu {
    Assert-Tools @('adb', 'emulator')

    foreach ($app in $Apps) {
        $running = Get-RunningAvds | Where-Object { $_.Avd -eq $app.Avd }
        if ($running) {
            Write-Ok "$($app.Avd) ya está corriendo ($($running.Serial))"
            continue
        }
        Write-Step "Arrancando $($app.Avd)"
        # Ventana propia: el emulador bloquea la consola desde donde se lanza.
        Start-Process -FilePath 'emulator' -ArgumentList "-avd $($app.Avd)" -WindowStyle Minimized
        Write-Dim 'booteando…'
    }

    Write-Step 'Esperando el arranque'
    foreach ($app in $Apps) {
        $serial = $null
        foreach ($i in 1..120) {
            $found = Get-RunningAvds | Where-Object { $_.Avd -eq $app.Avd }
            if ($found) {
                # Aparecer en `adb devices` no alcanza: el sistema sigue
                # arrancando y un `am start` ahí se pierde en el vacío.
                $boot = (adb -s $found.Serial shell getprop sys.boot_completed 2>$null)
                if ($boot -match '1') { $serial = $found.Serial; break }
            }
            Start-Sleep -Seconds 2
        }
        if (-not $serial) { Write-Err2 "$($app.Avd) no terminó de arrancar"; continue }

        # Sin esto el emulador está en Mountain View: el dispatch busca a pocos
        # kilómetros del origen y TODOS los pedidos terminan en NO_DRIVERS, sin
        # ninguna pista de la causa.
        adb -s $serial emu geo fix $GeoLng $GeoLat | Out-Null
        Write-Ok "$($app.Avd) listo en Montevideo ($serial)"
    }
}

function Invoke-Apps {
    Assert-Tools @('adb', 'npx')
    Invoke-Emu

    foreach ($app in $Apps) {
        $dir = Join-Path $Root "apps\$($app.Name)"
        Write-Step "Instalando $($app.Name) en $($app.Avd)"

        # Un Metro viejo ocupando el puerto hace que Expo pida confirmación
        # interactiva —o falle— y desde una ventana lanzada por script eso queda
        # colgado sin que se vea por qué.
        $busy = Get-NetTCPConnection -LocalPort $app.Port -State Listen -ErrorAction SilentlyContinue
        if ($busy) {
            Write-Warn2 "el puerto $($app.Port) ya está ocupado: cerrá la ventana de Metro anterior"
        }

        # Cada app en su propia ventana con su propio Metro y un puerto FIJO.
        # Sin `--port`, Expo detecta el 8081 ocupado y se queda esperando una
        # respuesta interactiva que nadie va a dar desde un script.
        $cmd = "cd '$dir'; npx expo run:android --device $($app.Avd) --port $($app.Port)"
        Start-Process -FilePath 'powershell' -ArgumentList '-NoExit', '-Command', $cmd
        Write-Dim "puerto $($app.Port), en su propia ventana"
    }

    Write-Host ""
    Write-Warn2 'la compilación corre en las ventanas nuevas; dejalas abiertas'
    Write-Dim  'la primera vez tarda; después son menos de un minuto cada una'
}

function Invoke-Restart {
    Assert-Tools @('adb')
    Write-Step 'Reiniciando las apps'
    foreach ($app in $Apps) {
        $found = Get-RunningAvds | Where-Object { $_.Avd -eq $app.Avd }
        if (-not $found) { Write-Warn2 "$($app.Avd) no está corriendo"; continue }
        adb -s $found.Serial shell am force-stop $($app.Package) 2>$null | Out-Null
        adb -s $found.Serial shell monkey -p $($app.Package) -c android.intent.category.LAUNCHER 1 2>$null | Out-Null
        Write-Ok "$($app.Name) reiniciada"
    }
}

# ── estado ───────────────────────────────────────────────────────────────────

function Invoke-Status {
    Sync-Path
    Write-Step 'Contenedores'
    if (Test-Cmd 'docker') {
        Push-Location $Root
        docker compose ps --format 'table {{.Name}}\t{{.Status}}'
        Pop-Location
    } else { Write-Err2 'docker no está en el PATH' }

    Write-Step 'Emuladores'
    if (Test-Cmd 'adb') {
        $running = Get-RunningAvds
        if ($running.Count -eq 0) { Write-Warn2 'ninguno corriendo' }
        foreach ($r in $running) { Write-Ok "$($r.Avd)  $($r.Serial)" }
    } else { Write-Err2 'adb no está en el PATH' }

    Write-Step 'Versión y git'
    $version = Get-Version
    Write-Ok "versión $version"
    Push-Location $Root
    $branch = git rev-parse --abbrev-ref HEAD 2>$null
    $dirty = git status --porcelain 2>$null
    Write-Ok "rama $branch"
    if ($dirty) { Write-Warn2 "hay cambios sin commitear ($(@($dirty).Count) archivos)" }
    else { Write-Ok 'árbol limpio' }
    Pop-Location
}

# ── versiones ────────────────────────────────────────────────────────────────

$VersionFiles = @(
    'package.json',
    'packages\domain\package.json',
    'services\api\package.json',
    'apps\shared\package.json',
    'apps\rider\package.json',
    'apps\driver\package.json'
)

function Get-Version {
    $raw = Get-Content (Join-Path $Root 'package.json') -Raw
    if ($raw -match '"version"\s*:\s*"([^"]+)"') { return $Matches[1] }
    return '0.0.0'
}

function Step-Version([string]$current, [string]$kind) {
    $parts = $current.Split('.')
    $major = [int]$parts[0]; $minor = [int]$parts[1]; $patch = [int]$parts[2]
    switch ($kind) {
        'major' { $major++; $minor = 0; $patch = 0 }
        'minor' { $minor++; $patch = 0 }
        default { $patch++ }
    }
    return "$major.$minor.$patch"
}

function Set-Version([string]$next) {
    # Se edita con regex y no con ConvertTo-Json a propósito: el round-trip por
    # objeto reordena las claves y reformatea el archivo entero, y un diff de
    # 200 líneas para cambiar un número esconde lo que realmente cambió.
    foreach ($rel in $VersionFiles) {
        $path = Join-Path $Root $rel
        if (-not (Test-Path $path)) { continue }
        $raw = Get-Content $path -Raw
        $new = [regex]::Replace($raw, '("version"\s*:\s*")[^"]+(")', "`${1}$next`${2}", 1)
        Set-Content -Path $path -Value $new -NoNewline
        Write-Ok $rel
    }

    # Las apps además llevan la versión que ve Android.
    foreach ($app in $Apps) {
        $path = Join-Path $Root "apps\$($app.Name)\app.json"
        if (-not (Test-Path $path)) { continue }
        $raw = Get-Content $path -Raw
        $raw = [regex]::Replace($raw, '("version"\s*:\s*")[^"]+(")', "`${1}$next`${2}", 1)
        # versionCode es un ENTERO que Android exige que suba en cada release.
        # No se deriva de la versión semántica: son dos numeraciones distintas y
        # mezclarlas rompe las actualizaciones cuando se publica un parche.
        if ($raw -match '"versionCode"\s*:\s*(\d+)') {
            $code = [int]$Matches[1] + 1
            $raw = [regex]::Replace($raw, '("versionCode"\s*:\s*)\d+', "`${1}$code", 1)
            Write-Dim "apps\$($app.Name)\app.json  versionCode $code"
        }
        Set-Content -Path $path -Value $raw -NoNewline
        Write-Ok "apps\$($app.Name)\app.json"
    }
}

function Invoke-Release([string]$kind) {
    if ($kind -eq '') { $kind = 'patch' }
    if ($kind -notin @('patch', 'minor', 'major')) {
        Stop-Here "versión inválida '$kind'. Usá patch, minor o major."
    }
    Assert-Tools @('git', 'npm', 'docker')
    Push-Location $Root

    # ── Nada se publica sin árbol limpio ──
    #
    # Con cambios sueltos, el tag apuntaría a un commit que no incluye lo que se
    # probó, y meses después nadie puede reconstruir qué se publicó.
    $dirty = git status --porcelain 2>$null
    if ($dirty) {
        Write-Warn2 'hay cambios sin commitear:'
        git status --short
        Write-Host ''
        if (-not $Yes) {
            $answer = Read-Host '  ¿Incluirlos en el release? (si/no)'
            if ($answer -ne 'si') { Pop-Location; Stop-Here 'cancelado: commiteá o descartá primero' }
        }
    }

    $current = Get-Version
    $next = Step-Version $current $kind
    Write-Step "Release $current → $next"

    # ── Verificar ANTES de tocar nada ──
    #
    # Si los tests fallan después de haber subido la versión, queda un árbol a
    # medio camino que hay que revertir a mano. Primero se prueba, después se
    # numera.
    Pop-Location
    Invoke-Check
    Invoke-Api
    Push-Location $Root

    Write-Step 'Subiendo la versión'
    Set-Version $next

    Write-Step 'Commit y tag'
    git add -A
    git commit -m "v$next"
    if ($LASTEXITCODE -ne 0) { Pop-Location; Stop-Here 'el commit falló' }

    git tag -a "v$next" -m "Orbit Rides v$next"
    if ($LASTEXITCODE -ne 0) { Pop-Location; Stop-Here 'no se pudo crear el tag (¿ya existe?)' }

    Write-Step 'Push'
    git push
    if ($LASTEXITCODE -ne 0) { Pop-Location; Stop-Here 'el push falló' }
    git push origin "v$next"
    if ($LASTEXITCODE -ne 0) { Pop-Location; Stop-Here 'no se pudo pushear el tag' }

    Pop-Location
    Write-Host ""
    Write-Ok "v$next publicada"
    Write-Dim 'para instalarla en los emuladores:  .\orbit.ps1 apps'
}

# ── ayuda ────────────────────────────────────────────────────────────────────

function Show-Help {
    Write-Host ""
    Write-Host "  Orbit Rides — orquestador" -ForegroundColor Magenta
    Write-Host "  versión $(Get-Version)" -ForegroundColor DarkGray
    Write-Host ""
    $rows = @(
        @('up',      'Levanta el backend, migra y siembra si hace falta'),
        @('down',    'Baja los contenedores (los datos sobreviven)'),
        @('check',   'Typecheck y todos los tests. No toca nada.'),
        @('api',     'Reconstruye el API, migra y corre el smoke'),
        @('emu',     'Arranca los emuladores y los ubica en Montevideo'),
        @('apps',    'Reinstala las dos apps, cada una en su ventana'),
        @('restart', 'Reinicia las apps sin recompilar'),
        @('dev',     'up + check + api + apps. El ciclo completo.'),
        @('status',  'Qué está corriendo y en qué versión'),
        @('release', 'Sube la versión, verifica, commitea, taguea y pushea')
    )
    foreach ($r in $rows) {
        Write-Host ("    {0,-9} {1}" -f $r[0], $r[1])
    }
    Write-Host ""
    Write-Host "  Ejemplos:" -ForegroundColor Yellow
    Write-Host "    .\orbit.ps1 dev"
    Write-Host "    .\orbit.ps1 api -SkipTests"
    Write-Host "    .\orbit.ps1 release minor"
    Write-Host "    .\orbit.ps1 up -Fresh"
    Write-Host ""
}

# ── despacho ─────────────────────────────────────────────────────────────────

switch ($Command.ToLower()) {
    'up'      { Invoke-Up }
    'down'    { Invoke-Down }
    'check'   { Invoke-Check }
    'api'     { Invoke-Api }
    'emu'     { Invoke-Emu }
    'apps'    { Invoke-Apps }
    'restart' { Invoke-Restart }
    'status'  { Invoke-Status }
    'release' { Invoke-Release $Arg }
    'dev'     { Invoke-Up; Invoke-Check; Invoke-Api; Invoke-Apps }
    default   { Show-Help }
}

Write-Host ""

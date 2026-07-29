# =====================================================================
#  APTraslados + Orbit Rides - Setup de entorno de desarrollo (Windows)
#
#  Uso:
#    setup-dev.bat                  -> stack completo salvo Android
#    setup-dev.bat -Android         -> agrega Android Studio (~12 GB)
#    setup-dev.bat -SkipDocker      -> omite Docker Desktop
#
#  Ejecutar como administrador la primera vez (Docker lo requiere).
# =====================================================================

param(
    [switch]$Android,
    [switch]$SkipDocker
)

$ErrorActionPreference = 'Continue'
$repo  = $PSScriptRoot
$orbit = Join-Path $repo 'orbit-rides'

function Write-Step($m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }
function Write-Ok($m)   { Write-Host "  [OK]    $m" -ForegroundColor Green }
function Write-Warn2($m){ Write-Host "  [!]     $m" -ForegroundColor Yellow }
function Write-Err2($m) { Write-Host "  [FALLO] $m" -ForegroundColor Red }
function Test-Cmd($n)   { [bool](Get-Command $n -ErrorAction SilentlyContinue) }

function Sync-Path {
    $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' +
                [Environment]::GetEnvironmentVariable('Path','User')
}

function Install-Winget($id, $cmdName, $label) {
    if ($cmdName -and (Test-Cmd $cmdName)) {
        Write-Ok "$label ya instalado"
        return
    }
    Write-Host "  Instalando $label ..." -ForegroundColor White
    winget install --id $id -e --source winget `
        --accept-package-agreements --accept-source-agreements | Out-Null
    Sync-Path
    if ($cmdName -and (Test-Cmd $cmdName)) { Write-Ok "$label instalado" }
    elseif (-not $cmdName)                 { Write-Ok "${label}: winget termino" }
    else { Write-Warn2 "$label instalado pero no visible en PATH todavia (abri una terminal nueva)" }
}

Write-Host ""
Write-Host "  APTraslados (PWA Firebase) + Orbit Rides (monorepo TS)" -ForegroundColor Magenta
Write-Host "  Repo: $repo" -ForegroundColor DarkGray

# ---------------------------------------------------------------------
Write-Step "0. winget"
if (-not (Test-Cmd 'winget')) {
    Write-Err2 "winget no disponible. Instala 'App Installer' desde Microsoft Store."
    exit 1
}
Write-Ok "winget disponible"

# ---------------------------------------------------------------------
Write-Step "1. Higiene de git"

$lock = Join-Path $repo '.git\index.lock'
if (Test-Path $lock) {
    Write-Warn2 "Existe .git\index.lock (bloquea add/commit). Borrandolo..."
    Remove-Item -Force $lock -ErrorAction SilentlyContinue
    if (Test-Path $lock) { Write-Err2 "No se pudo borrar. Borralo a mano: del /f `"$lock`"" }
    else { Write-Ok "index.lock borrado" }
} else {
    Write-Ok "sin index.lock"
}

Push-Location $repo
$branch = git rev-parse --abbrev-ref HEAD 2>$null
$remote = git remote get-url origin 2>$null
Write-Ok "rama: $branch   remote: $remote"

$dirty = git status --porcelain 2>$null
if ($dirty) {
    $realDiff = git diff --ignore-all-space --stat 2>$null
    if (-not $realDiff) {
        Write-Warn2 "Hay archivos 'modificados' que son SOLO cambios de fin de linea (CRLF/LF)."
        Write-Host  "         Para descartarlos:  git checkout -- ." -ForegroundColor DarkGray
    } else {
        Write-Warn2 "Hay cambios reales sin commitear. Revisalos con: git status"
    }
}
Pop-Location

# ---------------------------------------------------------------------
Write-Step "2. Herramientas base"
Install-Winget 'Git.Git'           'git'    'Git'
Install-Winget 'OpenJS.NodeJS.LTS' 'node'   'Node.js LTS'
Install-Winget 'Python.Python.3.12' 'python' 'Python 3.12'
Install-Winget 'GitHub.cli'        'gh'     'GitHub CLI'
Sync-Path

if (Test-Cmd 'node') {
    $nv = (node --version) -replace 'v',''
    if ([int]($nv.Split('.')[0]) -lt 22) {
        Write-Err2 "Node $nv es muy viejo. Orbit Rides pide >= 22. Actualizalo."
    } else { Write-Ok "Node $nv (>= 22, ok)" }
}

# ---------------------------------------------------------------------
Write-Step "3. Firebase CLI (para el sitio APTraslados)"
if (Test-Cmd 'npm') {
    if (Test-Cmd 'firebase') { Write-Ok "firebase-tools ya instalado" }
    else {
        npm install -g firebase-tools
        Sync-Path
        if (Test-Cmd 'firebase') { Write-Ok "firebase-tools instalado" }
        else { Write-Warn2 "instalado pero fuera del PATH de esta sesion" }
    }
} else { Write-Err2 "npm no disponible; abri una terminal nueva y reintenta" }

# ---------------------------------------------------------------------
Write-Step "4. Docker Desktop (para el backend de Orbit Rides)"
if ($SkipDocker) {
    Write-Warn2 "omitido por -SkipDocker"
} else {
    Install-Winget 'Docker.DockerDesktop' 'docker' 'Docker Desktop'
    Write-Warn2 "Docker Desktop necesita reinicio y que lo abras una vez a mano."
    Write-Host  "         Requiere WSL2 / plataforma de hipervisor habilitada." -ForegroundColor DarkGray
}

# ---------------------------------------------------------------------
Write-Step "5. Android (apps rider / driver)"
if (-not $Android) {
    Write-Warn2 "omitido. Corre 'setup-dev.bat -Android' cuando quieras las apps (~12 GB)."
} else {
    Install-Winget 'Google.AndroidStudio' $null 'Android Studio'

    $sdk = "$env:LOCALAPPDATA\Android\Sdk"
    if (Test-Path $sdk) {
        [Environment]::SetEnvironmentVariable('ANDROID_HOME',     $sdk, 'User')
        [Environment]::SetEnvironmentVariable('ANDROID_SDK_ROOT', $sdk, 'User')
        $userPath = [Environment]::GetEnvironmentVariable('Path','User')
        foreach ($r in @("$sdk\platform-tools", "$sdk\emulator", "$sdk\cmdline-tools\latest\bin")) {
            if ($userPath -notlike "*$r*") { $userPath = "$userPath;$r" }
        }
        [Environment]::SetEnvironmentVariable('Path', $userPath, 'User')
        Write-Ok "ANDROID_HOME = $sdk"
    } else {
        Write-Warn2 "SDK no encontrado en $sdk. Abri Android Studio, corre el asistente Standard,"
        Write-Host  "         instala API 34 + Build-Tools + Emulator, y volve a correr con -Android." -ForegroundColor DarkGray
    }

    $jdk = @(
        "C:\Program Files\Android\Android Studio\jbr",
        "C:\Program Files\Android\Android Studio\jre",
        "$env:LOCALAPPDATA\Programs\Android Studio\jbr"
    ) | Where-Object { Test-Path "$_\bin\java.exe" } | Select-Object -First 1

    if ($jdk) {
        [Environment]::SetEnvironmentVariable('JAVA_HOME', $jdk, 'User')
        $env:JAVA_HOME = $jdk
        Write-Ok "JAVA_HOME = $jdk"
    } else {
        Write-Warn2 "JDK de Android Studio no encontrado. Ver apps/SETUP-ANDROID.md seccion 6."
    }
    Sync-Path
}

# ---------------------------------------------------------------------
Write-Step "6. Dependencias de Orbit Rides"
if (-not (Test-Path $orbit)) {
    Write-Err2 "No existe $orbit"
} elseif (-not (Test-Cmd 'npm')) {
    Write-Err2 "npm no disponible en esta sesion. Abri una terminal nueva y corre: cd orbit-rides; npm install; npm run verify"
} else {
    Push-Location $orbit
    # node_modules traido de otra maquina rompe los symlinks de workspaces
    if (Test-Path 'node_modules') {
        Write-Warn2 "Ya hay node_modules. Si da 'Cannot find module @orbit/domain', borralo y reinstala."
    }
    Write-Host "  npm install ..." -ForegroundColor White
    npm install
    if ($LASTEXITCODE -eq 0) {
        Write-Ok "dependencias instaladas"
        Write-Host "  npm run verify ..." -ForegroundColor White
        npm run verify
        if ($LASTEXITCODE -eq 0) { Write-Ok "verify paso (esperado: 85 dominio + 44 API + 37 cliente)" }
        else { Write-Err2 "verify fallo. Ver orbit-rides/README.md paso 1." }
    } else {
        Write-Err2 "npm install fallo."
    }
    Pop-Location
}

# ---------------------------------------------------------------------
Write-Step "7. Resumen"
foreach ($t in @(
    @{n='git';l='Git'}, @{n='node';l='Node.js'}, @{n='npm';l='npm'},
    @{n='python';l='Python'}, @{n='gh';l='GitHub CLI'},
    @{n='firebase';l='Firebase CLI'}, @{n='docker';l='Docker'},
    @{n='adb';l='adb (Android)'}
)) {
    if (Test-Cmd $t.n) { Write-Ok $t.l } else { Write-Err2 "$($t.l) NO detectado" }
}

Write-Host ""
Write-Host "  Falta hacer a mano (requieren tu login):" -ForegroundColor Yellow
Write-Host "    firebase login"
Write-Host "    firebase use aptraslados"
Write-Host "    gh auth login"
Write-Host ""
Write-Host "  APTraslados:  iniciar.bat  ->  http://127.0.0.1:8765" -ForegroundColor DarkGray
Write-Host "                firebase deploy --only hosting" -ForegroundColor DarkGray
Write-Host "  Orbit Rides:  cd orbit-rides" -ForegroundColor DarkGray
Write-Host "                docker compose up -d --build" -ForegroundColor DarkGray
Write-Host "                docker compose --profile prepare up osrm-download osrm-build   # una vez" -ForegroundColor DarkGray
Write-Host "                npm run smoke" -ForegroundColor DarkGray
Write-Host ""
Read-Host "Presiona Enter para salir"

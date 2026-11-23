@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

set "CARGAR_SEMILLAS=1"
set "PAUSAR=1"
for %%A in (%*) do (
  if /I "%%~A"=="--sin-semillas" set "CARGAR_SEMILLAS=0"
  if /I "%%~A"=="--sin-pausa" set "PAUSAR=0"
)

echo ================================================================
echo   Trotamundos - Inicio automatico del prototipo
echo ================================================================
echo.

rem ----------------------------------------------------------------
rem 1. Verificar Node.js 24+ (e instalar con winget si falta)
rem ----------------------------------------------------------------
echo [1/5] Verificando Node.js 24+...
call :asegurar_node
if errorlevel 1 goto :error

rem ----------------------------------------------------------------
rem 2. Verificar Docker y abrir Docker Desktop si esta cerrado
rem ----------------------------------------------------------------
echo.
echo [2/5] Verificando Docker y Docker Compose v2...
call :asegurar_docker
if errorlevel 1 goto :error

rem ----------------------------------------------------------------
rem 3. Instalar dependencias npm si faltan o cambio package-lock.json
rem ----------------------------------------------------------------
echo.
echo [3/5] Verificando dependencias npm...
call :asegurar_dependencias
if errorlevel 1 goto :error

rem ----------------------------------------------------------------
rem 4. Levantar contenedores y cargar datos de prueba (semillas)
rem ----------------------------------------------------------------
echo.
echo [4/5] Levantando infraestructura en Docker (global, r1 y r2)...
call npm run infra:levantar
if errorlevel 1 (
  echo.
  echo [ERROR] Fallo "npm run infra:levantar". Revisa los logs arriba.
  goto :error
)

if "%CARGAR_SEMILLAS%"=="1" (
  echo.
  echo Cargando usuarios y viajes de prueba ^(npm run semillas^)...
  call npm run semillas
  if errorlevel 1 (
    echo.
    echo [ERROR] Fallo "npm run semillas".
    goto :error
  )
)

rem ----------------------------------------------------------------
rem 5. Levantar la aplicacion web y abrirla en el navegador
rem ----------------------------------------------------------------
echo.
echo [5/5] Iniciando aplicacion web...
echo.
echo ================================================================
echo   Trotamundos listo para probar
echo   Web:  http://localhost:5173
echo   API:  http://localhost:8000/health
echo.
echo   Cuentas de prueba ^(contrasena: Viajar-2026!^):
echo     - ana.garcia@correo.example   ^(region-1, vuelo XKQ7PL, hotel HC-48291^)
echo     - bruno.diaz@correo.example   ^(region-1, itinerario compartido^)
echo     - karina.molina@correo.example ^(region-2^)
echo     - analista@trotamundos.example ^(ver CONTRASENA_ANALISTA en .env^)
echo.
echo   Para detener contenedores luego: npm run infra:bajar
echo ================================================================
echo.

node -e "fetch('http://localhost:5173',{signal:AbortSignal.timeout(1500)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >nul 2>&1
if not errorlevel 1 (
  echo La aplicacion web ya estaba corriendo en http://localhost:5173. Abriendo navegador...
  start "" "http://localhost:5173"
  echo.
  call :pausar_si_doble_clic
  exit /b 0
)

echo Abriendo http://localhost:5173 en tu navegador...
echo ^(Mantene esta ventana abierta mientras uses la web. Presiona Ctrl+C para cerrarla.^)
echo.
call npm run dev -w web -- --open
if errorlevel 1 goto :error
exit /b 0

rem ================================================================
rem Subrutinas
rem ================================================================

:refrescar_path
for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"`) do (
  set "PATH=%%P"
)
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
exit /b 0

:asegurar_node
where node >nul 2>&1
if errorlevel 1 (
  if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
)
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js no esta instalado. Intentando instalar Node.js LTS ^(24+^) con winget...
  where winget >nul 2>&1
  if errorlevel 1 (
    echo [ERROR] No se encontro Node.js ni winget. Instala Node.js 24 desde https://nodejs.org y volve a ejecutar iniciar.bat.
    exit /b 1
  )
  winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
  if errorlevel 1 (
    echo [ERROR] No se pudo instalar Node.js con winget. Instalalo manualmente desde https://nodejs.org ^(version 24^).
    exit /b 1
  )
  call :refrescar_path
)

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js fue instalado pero todavia no figura en el PATH. Cerra esta ventana y volve a abrir iniciar.bat.
  exit /b 1
)

set "NODE_MAJOR=0"
set "NODE_VER=desconocida"
for /f "delims=" %%V in ('node -p "process.versions.node.split('.')[0]"') do set "NODE_MAJOR=%%V"
for /f "delims=" %%F in ('node -v') do set "NODE_VER=%%F"
if %NODE_MAJOR% LSS 24 (
  echo [ERROR] Se encontro Node.js %NODE_VER%, pero el proyecto requiere Node.js 24 o superior.
  echo         Actualiza Node.js desde https://nodejs.org o con: winget install -e --id OpenJS.NodeJS.LTS
  exit /b 1
)
echo   OK: Node.js %NODE_VER%
exit /b 0

:asegurar_docker
where docker >nul 2>&1
if errorlevel 1 (
  if exist "%ProgramFiles%\Docker\Docker\resources\bin\docker.exe" set "PATH=%ProgramFiles%\Docker\Docker\resources\bin;%PATH%"
  if exist "D:\Docker\Program\resources\bin\docker.exe" set "PATH=D:\Docker\Program\resources\bin;%PATH%"
)
where docker >nul 2>&1
if errorlevel 1 (
  echo Docker no esta instalado. Intentando instalar Docker Desktop con winget...
  where winget >nul 2>&1
  if errorlevel 1 (
    echo [ERROR] No se encontro Docker ni winget. Instala Docker Desktop desde https://www.docker.com/products/docker-desktop/ y volve a ejecutar iniciar.bat.
    exit /b 1
  )
  winget install -e --id Docker.DockerDesktop --accept-package-agreements --accept-source-agreements
  if errorlevel 1 (
    echo [ERROR] No se pudo instalar Docker Desktop con winget. Instalalo desde https://www.docker.com/products/docker-desktop/.
    exit /b 1
  )
  call :refrescar_path
  if exist "%ProgramFiles%\Docker\Docker\resources\bin\docker.exe" set "PATH=%ProgramFiles%\Docker\Docker\resources\bin;%PATH%"
)

where docker >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Docker Desktop fue instalado. Si es la primera vez, reinicia Windows o abri Docker Desktop una vez y volve a ejecutar iniciar.bat.
  exit /b 1
)

docker info >nul 2>&1
if not errorlevel 1 goto :docker_listo

echo Docker Desktop esta cerrado. Buscando ejecutable para abrirlo...
set "DOCKER_DESKTOP="
for /f "delims=" %%D in ('where docker 2^>nul') do (
  if not defined DOCKER_DESKTOP (
    for %%P in ("%%~dpD..\..") do (
      if exist "%%~fP\Docker Desktop.exe" set "DOCKER_DESKTOP=%%~fP\Docker Desktop.exe"
    )
  )
)
if not defined DOCKER_DESKTOP if exist "%ProgramFiles%\Docker\Docker\Docker Desktop.exe" set "DOCKER_DESKTOP=%ProgramFiles%\Docker\Docker\Docker Desktop.exe"
if not defined DOCKER_DESKTOP if exist "%LOCALAPPDATA%\Docker\Docker Desktop.exe" set "DOCKER_DESKTOP=%LOCALAPPDATA%\Docker\Docker Desktop.exe"
if not defined DOCKER_DESKTOP if exist "D:\Docker\Program\Docker Desktop.exe" set "DOCKER_DESKTOP=D:\Docker\Program\Docker Desktop.exe"

if not defined DOCKER_DESKTOP (
  echo [ERROR] Docker no responde y no se encontro "Docker Desktop.exe". Abri Docker Desktop manualmente y volve a ejecutar iniciar.bat.
  exit /b 1
)

echo   Abriendo "%DOCKER_DESKTOP%"...
start "" "%DOCKER_DESKTOP%"
echo   Esperando a que el motor de Docker termine de iniciar ^(hasta 3 minutos^)...

set /a "INTENTOS=0"
:esperar_docker
docker info >nul 2>&1
if not errorlevel 1 goto :docker_listo
set /a "INTENTOS+=1"
if %INTENTOS% GEQ 60 (
  echo [ERROR] Docker Desktop tardo demasiado en iniciar. Verifica que no este esperando confirmacion en pantalla y volve a intentar.
  exit /b 1
)
timeout /t 3 /nobreak >nul
goto :esperar_docker

:docker_listo
docker compose version >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Docker esta corriendo pero no se encontro Docker Compose v2 ^("docker compose"^).
  exit /b 1
)
for /f "delims=" %%V in ('docker info --format "{{.ServerVersion}}"') do echo   OK: Docker %%V listo
exit /b 0

:asegurar_dependencias
node -e "const fs=require('fs'),c=require('crypto');const lock='package-lock.json',nmLock='node_modules/.package-lock.json',bin='node_modules/.bin/vite.cmd',marca='node_modules/.trotamundos-lock.sha256';if(!fs.existsSync(nmLock)||!fs.existsSync(bin))process.exit(1);const h=c.createHash('sha256').update(fs.readFileSync(lock)).digest('hex');if(fs.existsSync(marca)){process.exit(fs.readFileSync(marca,'utf8').trim()===h?0:1);}if(fs.statSync(lock).mtimeMs>fs.statSync(nmLock).mtimeMs)process.exit(1);fs.writeFileSync(marca,h);process.exit(0);"
if not errorlevel 1 (
  echo   OK: Dependencias npm ya instaladas y actualizadas
  exit /b 0
)

echo   Instalando dependencias npm ^(npm ci^)...
call npm ci
if errorlevel 1 (
  echo [ERROR] Fallo "npm ci".
  exit /b 1
)
node -e "const fs=require('fs'),c=require('crypto');const h=c.createHash('sha256').update(fs.readFileSync('package-lock.json')).digest('hex');fs.writeFileSync('node_modules/.trotamundos-lock.sha256',h);"
echo   OK: Dependencias npm instaladas
exit /b 0

:pausar_si_doble_clic
if "%PAUSAR%"=="0" exit /b 0
echo %CMDCMDLINE% | find /i "/c" >nul 2>&1
if not errorlevel 1 pause
exit /b 0

:error
echo.
echo ================================================================
echo   No se pudo completar el inicio. Revisa el mensaje de error.
echo ================================================================
echo.
call :pausar_si_doble_clic
exit /b 1

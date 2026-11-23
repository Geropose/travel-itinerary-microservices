#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

CARGAR_SEMILLAS=1
for arg in "$@"; do
  if [[ "$arg" == "--sin-semillas" ]]; then
    CARGAR_SEMILLAS=0
  fi
done

echo "================================================================"
echo "  Trotamundos - Inicio automático del prototipo"
echo "================================================================"
echo

# ----------------------------------------------------------------
# 1. Verificar Node.js 24+
# ----------------------------------------------------------------
echo "[1/5] Verificando Node.js 24+..."
if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js no está instalado. Instalá Node.js 24 desde https://nodejs.org y volvé a ejecutar ./iniciar.sh." >&2
  exit 1
fi

NODE_VER="$(node -v)"
NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if (( NODE_MAJOR < 24 )); then
  echo "[ERROR] Se encontró Node.js ${NODE_VER}, pero el proyecto requiere Node.js 24 o superior." >&2
  exit 1
fi
echo "  OK: Node.js ${NODE_VER}"

# ----------------------------------------------------------------
# 2. Verificar Docker y abrir Docker Desktop si está cerrado
# ----------------------------------------------------------------
echo
echo "[2/5] Verificando Docker y Docker Compose v2..."
if ! command -v docker >/dev/null 2>&1; then
  echo "[ERROR] Docker no está instalado. Instalá Docker Desktop (o Docker Engine + Compose v2) y volvé a ejecutar ./iniciar.sh." >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker no está corriendo. Intentando iniciar Docker..."
  OS="$(uname -s)"
  case "$OS" in
    Darwin)
      open -a Docker || true
      ;;
    Linux)
      if command -v systemctl >/dev/null 2>&1; then
        systemctl --user start docker-desktop 2>/dev/null || sudo systemctl start docker 2>/dev/null || true
      fi
      ;;
    MINGW*|MSYS*|CYGWIN*)
      DOCKER_BIN="$(command -v docker)"
      DOCKER_DIR="$(cd "$(dirname "$DOCKER_BIN")/../.." 2>/dev/null && pwd || true)"
      if [[ -n "$DOCKER_DIR" && -f "$DOCKER_DIR/Docker Desktop.exe" ]]; then
        cmd.exe /c start "" "$(cygpath -w "$DOCKER_DIR/Docker Desktop.exe")" >/dev/null 2>&1 || true
      elif [[ -f "/c/Program Files/Docker/Docker/Docker Desktop.exe" ]]; then
        cmd.exe /c start "" "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe" >/dev/null 2>&1 || true
      fi
      ;;
  esac

  echo "  Esperando a que el motor de Docker termine de iniciar (hasta 3 minutos)..."
  LISTO=0
  for _ in $(seq 1 60); do
    if docker info >/dev/null 2>&1; then
      LISTO=1
      break
    fi
    sleep 3
  done
  if (( LISTO == 0 )); then
    echo "[ERROR] Docker no respondió a tiempo. Abrí Docker Desktop manualmente y volvé a ejecutar ./iniciar.sh." >&2
    exit 1
  fi
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "[ERROR] Docker está corriendo pero no se encontró Docker Compose v2 ('docker compose')." >&2
  exit 1
fi
echo "  OK: Docker $(docker info --format '{{.ServerVersion}}') listo"

# ----------------------------------------------------------------
# 3. Instalar dependencias npm si faltan o cambió package-lock.json
# ----------------------------------------------------------------
echo
echo "[3/5] Verificando dependencias npm..."
if node -e "const fs=require('fs'),c=require('crypto');const lock='package-lock.json',nmLock='node_modules/.package-lock.json',bin='node_modules/.bin/vite',marca='node_modules/.trotamundos-lock.sha256';if(!fs.existsSync(nmLock)||!fs.existsSync(bin))process.exit(1);const h=c.createHash('sha256').update(fs.readFileSync(lock)).digest('hex');if(fs.existsSync(marca)){process.exit(fs.readFileSync(marca,'utf8').trim()===h?0:1);}if(fs.statSync(lock).mtimeMs>fs.statSync(nmLock).mtimeMs)process.exit(1);fs.writeFileSync(marca,h);process.exit(0);"; then
  echo "  OK: Dependencias npm ya instaladas y actualizadas"
else
  echo "  Instalando dependencias npm (npm ci)..."
  npm ci
  node -e "const fs=require('fs'),c=require('crypto');const h=c.createHash('sha256').update(fs.readFileSync('package-lock.json')).digest('hex');fs.writeFileSync('node_modules/.trotamundos-lock.sha256',h);"
  echo "  OK: Dependencias npm instaladas"
fi

# ----------------------------------------------------------------
# 4. Levantar contenedores y cargar datos de prueba (semillas)
# ----------------------------------------------------------------
echo
echo "[4/5] Levantando infraestructura en Docker (global, r1 y r2)..."
npm run infra:levantar

if (( CARGAR_SEMILLAS == 1 )); then
  echo
  echo "Cargando usuarios y viajes de prueba (npm run semillas)..."
  npm run semillas
fi

# ----------------------------------------------------------------
# 5. Levantar la aplicación web y abrirla en el navegador
# ----------------------------------------------------------------
echo
echo "[5/5] Iniciando aplicación web..."
echo
echo "================================================================"
echo "  Trotamundos listo para probar"
echo "  Web:  http://localhost:5173"
echo "  API:  http://localhost:8000/health"
echo
echo "  Cuentas de prueba (contraseña: Viajar-2026!):"
echo "    - ana.garcia@correo.example   (region-1, vuelo XKQ7PL, hotel HC-48291)"
echo "    - bruno.diaz@correo.example   (region-1, itinerario compartido)"
echo "    - karina.molina@correo.example (region-2)"
echo "    - analista@trotamundos.example (ver CONTRASENA_ANALISTA en .env)"
echo
echo "  Para detener contenedores luego: npm run infra:bajar"
echo "================================================================"
echo

abrir_navegador() {
  local url="$1"
  case "$(uname -s)" in
    Darwin) open "$url" >/dev/null 2>&1 || true ;;
    Linux) xdg-open "$url" >/dev/null 2>&1 || true ;;
    MINGW*|MSYS*|CYGWIN*) cmd.exe /c start "" "$url" >/dev/null 2>&1 || true ;;
  esac
}

if node -e "fetch('http://localhost:5173',{signal:AbortSignal.timeout(1500)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
  echo "La aplicación web ya estaba corriendo en http://localhost:5173. Abriendo navegador..."
  abrir_navegador "http://localhost:5173"
  exit 0
fi

echo "Abriendo http://localhost:5173 en tu navegador..."
echo "(Mantené esta terminal abierta mientras uses la web. Presioná Ctrl+C para cerrarla.)"
echo
npm run dev -w web -- --open

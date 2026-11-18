#!/bin/bash
# Crea una base y un usuario por servicio (una base por servicio, ADR-001). Lo corre la imagen
# oficial de PostgreSQL la primera vez que arranca (docker-entrypoint-initdb.d).
#
# BASES: pares base:usuario separados por espacios, por ejemplo "usuarios:usuarios
# registro_accesos:gateway". La contraseña de cada usuario sale de CLAVE_BD_<USUARIO>.
#
# Cada base es del usuario de su servicio y nadie más puede conectarse (REVOKE ... FROM PUBLIC):
# un servicio no puede leer la base de otro.
set -e

for par in $BASES; do
  base="${par%%:*}"
  usuario="${par##*:}"
  variable="CLAVE_BD_${usuario^^}"
  clave="${!variable}"
  if [ -z "$clave" ]; then
    echo "Falta $variable para el usuario $usuario" >&2
    exit 1
  fi
  echo "Base $base del usuario $usuario"
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
    -v base="$base" -v usuario="$usuario" -v clave="$clave" <<'SQL'
CREATE ROLE :"usuario" LOGIN PASSWORD :'clave';
CREATE DATABASE :"base" OWNER :"usuario";
REVOKE ALL ON DATABASE :"base" FROM PUBLIC;
SQL
done

# Tampoco pueden entrar a la base "postgres" del administrador.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -c 'REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;'

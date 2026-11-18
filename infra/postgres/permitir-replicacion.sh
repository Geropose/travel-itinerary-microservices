#!/bin/bash
# Base principal de Viajes (centro de datos A): crea el usuario de replicación y le permite
# conectarse para la replicación nativa (streaming) hacia la read replica (ADR-012, Iteración 6).
set -e

if [ -z "$CLAVE_BD_REPLICACION" ]; then
  echo "Falta CLAVE_BD_REPLICACION" >&2
  exit 1
fi
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v clave="$CLAVE_BD_REPLICACION" <<'SQL'
CREATE ROLE replicador WITH REPLICATION LOGIN PASSWORD :'clave';
SQL
echo "host replication replicador all scram-sha-256" >> "$PGDATA/pg_hba.conf"

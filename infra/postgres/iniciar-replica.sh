#!/bin/bash
# Arranque de la read replica de Viajes (centro de datos B, ADR-012). La primera vez copia la base
# principal con pg_basebackup y deja la configuración de standby (--write-recovery-conf): desde ahí
# recibe los cambios por replicación nativa y solo acepta lecturas. Si la principal falla, se la
# puede promover con pg_ctl promote.
set -e

if [ ! -s "$PGDATA/PG_VERSION" ]; then
  if [ -z "$CLAVE_BD_REPLICACION" ] || [ -z "$PRINCIPAL" ]; then
    echo "Faltan PRINCIPAL o CLAVE_BD_REPLICACION" >&2
    exit 1
  fi
  export PGPASSWORD="$CLAVE_BD_REPLICACION"
  until pg_basebackup --host="$PRINCIPAL" --username=replicador --pgdata="$PGDATA" \
    --wal-method=stream --write-recovery-conf --checkpoint=fast; do
    echo "La base principal ($PRINCIPAL) todavía no responde: reintento en 2 s"
    rm -rf "${PGDATA:?}"/*
    sleep 2
  done
  unset PGPASSWORD
  echo "Read replica inicializada desde $PRINCIPAL"
fi

# La imagen oficial ve que la base ya existe y arranca el servidor sin inicializar nada.
exec docker-entrypoint.sh postgres

#!/bin/bash
# Arranque de los nodos 2 y 3 de RabbitMQ (perfil ha). La primera vez (volumen vacío) esperan a que
# el nodo 1 esté corriendo: si arrancan antes, no lo encuentran y forman un cluster propio. Las
# veces siguientes arrancan enseguida, porque el nodo 1 ya está en el cluster y espera a los otros
# para tener quórum.
set -e

if [ -z "$(ls -A /var/lib/rabbitmq/mnesia 2>/dev/null)" ]; then
  echo "Primer arranque: espero al nodo rabbit@rabbitmq para unirme a su cluster"
  until rabbitmq-diagnostics -q -n rabbit@rabbitmq check_running > /dev/null 2>&1; do
    sleep 2
  done
fi

exec docker-entrypoint.sh rabbitmq-server

# Imagen de usuarios. Se construye desde la raíz del repositorio, porque usa packages/comun y specs/:
#   docker build -f services/usuarios/Dockerfile -t trotamundos/usuarios .

# 1) Dependencias de producción de este servicio (y del kit común), con el lockfile del monorepo.
FROM node:24-alpine AS dependencias
WORKDIR /app
COPY . .
RUN npm ci --omit=dev --ignore-scripts --workspace services/usuarios \
  && npm cache clean --force

# 2) Imagen final: solo lo que hace falta para correr, con un usuario sin privilegios.
FROM node:24-alpine
ENV NODE_ENV=production \
    PUERTO=3002
WORKDIR /app
COPY --from=dependencias --chown=node:node /app/package.json ./
COPY --from=dependencias --chown=node:node /app/node_modules ./node_modules
COPY --from=dependencias --chown=node:node /app/packages/comun ./packages/comun
COPY --from=dependencias --chown=node:node /app/specs ./specs
COPY --from=dependencias --chown=node:node /app/services/usuarios ./services/usuarios
USER node
EXPOSE 3002
HEALTHCHECK --interval=5s --timeout=2s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PUERTO}/health" > /dev/null || exit 1
# Node 24 corre el TypeScript directo (sin compilar).
CMD ["node", "services/usuarios/src/index.ts"]

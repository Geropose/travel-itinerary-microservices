# Imagen de autenticacion. Se construye desde la raíz del repositorio, porque usa packages/comun y specs/:
#   docker build -f services/autenticacion/Dockerfile -t trotamundos/autenticacion .

# 1) Dependencias de producción de este servicio (y del kit común), con el lockfile del monorepo.
FROM node:24-alpine AS dependencias
WORKDIR /app
COPY . .
RUN npm ci --omit=dev --ignore-scripts --workspace services/autenticacion \
  && npm cache clean --force

# 2) Imagen final: solo lo que hace falta para correr, con un usuario sin privilegios.
FROM node:24-alpine
ENV NODE_ENV=production \
    PUERTO=3001
WORKDIR /app
COPY --from=dependencias --chown=node:node /app/package.json ./
COPY --from=dependencias --chown=node:node /app/node_modules ./node_modules
COPY --from=dependencias --chown=node:node /app/packages/comun ./packages/comun
COPY --from=dependencias --chown=node:node /app/specs ./specs
COPY --from=dependencias --chown=node:node /app/services/autenticacion ./services/autenticacion
USER node
EXPOSE 3001
HEALTHCHECK --interval=5s --timeout=2s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PUERTO}/health" > /dev/null || exit 1
# Node 24 corre el TypeScript directo (sin compilar).
CMD ["node", "services/autenticacion/src/index.ts"]

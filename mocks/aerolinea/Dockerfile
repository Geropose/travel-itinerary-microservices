# Imagen del mock de Aerolínea Andina. Se construye desde la raíz del repositorio:
#   docker build -f mocks/aerolinea/Dockerfile -t trotamundos/mock-aerolinea .

FROM node:24-alpine AS dependencias
WORKDIR /app
COPY . .
RUN npm ci --omit=dev --ignore-scripts --workspace mocks/aerolinea \
  && npm cache clean --force

FROM node:24-alpine
ENV NODE_ENV=production \
    PUERTO=4003
WORKDIR /app
COPY --from=dependencias --chown=node:node /app/package.json ./
COPY --from=dependencias --chown=node:node /app/node_modules ./node_modules
COPY --from=dependencias --chown=node:node /app/packages/comun ./packages/comun
COPY --from=dependencias --chown=node:node /app/mocks/comun ./mocks/comun
COPY --from=dependencias --chown=node:node /app/mocks/aerolinea ./mocks/aerolinea
USER node
EXPOSE 4003
HEALTHCHECK --interval=5s --timeout=2s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PUERTO}/health" > /dev/null || exit 1
CMD ["node", "mocks/aerolinea/src/index.ts"]

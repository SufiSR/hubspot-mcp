FROM node:lts-alpine

WORKDIR /app

ENV NODE_OPTIONS="--max-old-space-size=4096"

EXPOSE 3000

COPY --chown=node:node package.json package-lock.json .npmrc ./

RUN npm ci

COPY --chown=node:node src/ ./src/
COPY --chown=node:node tsconfig.json ./

RUN npm run build

USER node

ENTRYPOINT ["node", "dist/index.js"]

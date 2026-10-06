FROM node:22-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV DATABASE_URL=postgresql://knowflow:build_only@127.0.0.1:5432/knowflow?schema=public
COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:22-slim AS production-dependencies

RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV DATABASE_URL=postgresql://knowflow:build_only@127.0.0.1:5432/knowflow?schema=public
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev
RUN npx prisma generate

FROM node:22-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app

COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/package.json ./package.json

USER node
EXPOSE 8000

CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]

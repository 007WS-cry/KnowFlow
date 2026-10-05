FROM node:22-alpine AS build

RUN apk add --no-cache openssl
WORKDIR /app
ENV DATABASE_URL=postgresql://knowflow:build_only@127.0.0.1:5432/knowflow?schema=public
COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:22-alpine AS production-dependencies

RUN apk add --no-cache openssl
WORKDIR /app
ENV DATABASE_URL=postgresql://knowflow:build_only@127.0.0.1:5432/knowflow?schema=public
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev
RUN npx prisma generate

FROM node:22-alpine AS runtime

RUN apk add --no-cache openssl
ENV NODE_ENV=production
WORKDIR /app

COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/package.json ./package.json

USER node
EXPOSE 8000

CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]

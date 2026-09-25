# Multi-stage production Dockerfile for ImprintID Dynamic Pricing
FROM node:22-alpine AS builder

WORKDIR /app
RUN apk add --no-cache openssl python3 make g++

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .

# Generate Prisma client for Linux and build React Router app
RUN npx prisma generate --schema=prisma/schema.postgresql.prisma
RUN cp prisma/schema.postgresql.prisma prisma/schema.prisma
RUN npm run build

# Stage 2: Runner
FROM node:22-alpine AS runner

WORKDIR /app
RUN apk add --no-cache openssl dumb-init

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy built application and prisma schemas from builder
COPY --from=builder /app/build ./build
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma/client ./node_modules/@prisma/client
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/extensions ./extensions
COPY --from=builder /app/docker-entrypoint.sh ./docker-entrypoint.sh

RUN chmod +x ./docker-entrypoint.sh

USER node

ENTRYPOINT ["/usr/bin/dumb-init", "--", "./docker-entrypoint.sh"]
CMD ["npm", "run", "start"]


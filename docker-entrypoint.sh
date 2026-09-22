#!/bin/sh
set -e

echo "Starting ImprintID Dynamic Pricing Web Service..."

# If DATABASE_URL is configured for PostgreSQL, synchronize database schema
if [ -n "$DATABASE_URL" ]; then
  case "$DATABASE_URL" in
    postgres*|postgresql*)
      echo "PostgreSQL database detected. Synchronizing Prisma schema..."
      npx prisma db push --schema=prisma/schema.postgresql.prisma --accept-data-loss || true
      ;;
    *)
      echo "Applying SQLite migrations..."
      npx prisma migrate deploy || true
      ;;
  esac
fi

exec "$@"

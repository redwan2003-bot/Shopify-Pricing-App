#!/bin/sh
set -e

echo "Starting ImprintID Dynamic Pricing Web Service..."

# Strip any accidental carriage returns or surrounding quotes from DATABASE_URL
if [ -n "$DATABASE_URL" ]; then
  DATABASE_URL=$(printf '%s' "$DATABASE_URL" | tr -d '\r' | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")
  export DATABASE_URL
fi

if [ -n "$DATABASE_URL" ]; then
  case "$DATABASE_URL" in
    postgres*|postgresql*)
      echo "PostgreSQL database detected. Synchronizing Prisma schema..."
      npx prisma db push --schema=prisma/schema.postgresql.prisma --accept-data-loss --skip-generate || true
      ;;
    *)
      echo "Warning: DATABASE_URL does not start with postgresql:// or postgres://."
      echo "Prefix is: $(printf '%s' "$DATABASE_URL" | cut -c 1-15)..."
      ;;
  esac
else
  echo "ERROR: DATABASE_URL is not set in environment variables!"
fi

exec "$@"


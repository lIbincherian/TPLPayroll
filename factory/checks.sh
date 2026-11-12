#!/usr/bin/env bash
# The repo's checks. Exit 0 only when the branch is fit to review.
#
# The gate runs this script from the main checkout with the job's worktree as
# the working directory. Keep it fast, deterministic and non-interactive: no
# watch modes, no prompts, nothing that rewrites files.
#
# Mirrors .github/workflows/ci.yml jobs lint-typecheck, unit and build, plus its
# migration-history guard. The CI jobs that need PostgreSQL (migrations, e2e)
# are not run here; CI runs them on the PR.
set -euo pipefail

# Same environment as CI: no real credentials, so the app uses its in-process
# mocks, and `next build` only needs database URLs that parse.
export CI=true NEXT_TELEMETRY_DISABLED=1
export SUPABASE_URL="" SUPABASE_SERVICE_ROLE_KEY=""
export ETIMEOFFICE_CORPORATE_ID="" ETIMEOFFICE_USERNAME="" ETIMEOFFICE_PASSWORD="" ETIMEOFFICE_BASE_URL=""

# A fresh worktree has no node_modules; reinstall when the lockfile changed.
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  npm ci --prefer-offline --no-audit --no-fund
fi

# Migration history (CI's guard): a changed schema.prisma ships with a new
# migration, and existing migrations are never edited, renamed or deleted.
range="origin/main...HEAD"
if ! git diff --quiet "$range" -- prisma/schema.prisma; then
  if [ -z "$(git diff --name-only --diff-filter=A "$range" -- 'prisma/migrations/*/migration.sql')" ]; then
    echo "prisma/schema.prisma changed but no new prisma/migrations/<name>/migration.sql was added." >&2
    exit 1
  fi
fi
changed="$(git diff --name-only --diff-filter=MDR "$range" -- 'prisma/migrations/*/migration.sql')"
if [ -n "$changed" ]; then
  printf 'Existing migrations must not be edited, renamed or deleted:\n%s\n' "$changed" >&2
  exit 1
fi

# lint-typecheck: tsc needs the generated (gitignored) Prisma client.
npx prisma generate
npm run lint
npx tsc --noEmit

# unit
npm run test:run

# build: never connects to a database; the URLs only have to parse.
DATABASE_URL=postgresql://ci:ci@127.0.0.1:5432/ci \
DIRECT_DATABASE_URL=postgresql://ci:ci@127.0.0.1:5432/ci \
  npm run build

#!/usr/bin/env bash
# The repo's checks. Exit 0 only when the branch is fit to review.
#
# The gate runs this script from the main checkout with the job's worktree as
# the working directory. Keep it fast, deterministic and non-interactive: no
# watch modes, no prompts, nothing that rewrites files.
#
# E2E tests (npm run test:e2e) are not run here: they need a local PostgreSQL
# and a seeded database (see AGENTS.md).
set -euo pipefail

# A fresh worktree has no node_modules; reinstall when the lockfile changed.
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  npm ci --prefer-offline --no-audit --no-fund
fi

# The Prisma client (src/generated/prisma) is gitignored; typecheck needs it.
npx prisma generate

npm run lint
npx tsc --noEmit
npm run test:run
npm run build

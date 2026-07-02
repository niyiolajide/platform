#!/bin/bash
# release.sh — cut a release for this lib: sync package.json version <-> annotated git tag, push both.
#
# Convention (personal lib, kept deliberately simple):
#   - main is the release branch; every release is an annotated tag vX.Y.Z on main.
#   - package.json "version" and the tag MUST match; this script is the only way either changes.
#   - dist/ is committed (consumers install the git SHA/tag directly). Build happens in Docker
#     BEFORE releasing: run `npm run verify-dist` in a node container and commit dist if it changed.
#     This script refuses to release if dist/ looks older than src/.
#
# Usage: scripts/release.sh <X.Y.Z|patch|minor|major>
set -euo pipefail
cd "$(dirname "$0")/.."

ARG="${1:?usage: scripts/release.sh <X.Y.Z|patch|minor|major>}"

[ -z "$(git status --porcelain)" ] || { echo "ERROR: working tree not clean" >&2; exit 1; }
BRANCH=$(git branch --show-current)
[ "$BRANCH" = "main" ] || { echo "ERROR: releases are cut from main (on: $BRANCH)" >&2; exit 1; }
git fetch -q origin
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || {
  echo "ERROR: local main != origin/main — push/pull first" >&2; exit 1; }

# dist freshness guard: last commit touching src must not be newer than last touching dist.
if [ -d dist ] && [ -d src ]; then
  SRC_T=$(git log -1 --format=%ct -- src)
  DIST_T=$(git log -1 --format=%ct -- dist)
  if [ "${SRC_T:-0}" -gt "${DIST_T:-0}" ]; then
    echo "ERROR: src/ committed more recently than dist/ — rebuild in Docker (npm run verify-dist) and commit dist first." >&2
    exit 1
  fi
fi

CUR=$(python3 -c "import json;print(json.load(open('package.json'))['version'])")
case "$ARG" in
  patch|minor|major)
    NEW=$(python3 - "$CUR" "$ARG" <<'EOF'
import sys
maj, mi, pa = (int(x) for x in sys.argv[1].split('.'))
kind = sys.argv[2]
if kind == 'major': maj, mi, pa = maj + 1, 0, 0
elif kind == 'minor': mi, pa = mi + 1, 0
else: pa += 1
print(f"{maj}.{mi}.{pa}")
EOF
) ;;
  *) NEW="$ARG"
     python3 -c "import re,sys; sys.exit(0 if re.fullmatch(r'\d+\.\d+\.\d+', '$NEW') else 1)" \
       || { echo "ERROR: '$NEW' is not X.Y.Z" >&2; exit 1; } ;;
esac

git rev-parse -q --verify "refs/tags/v$NEW" >/dev/null && { echo "ERROR: tag v$NEW already exists" >&2; exit 1; }

# surgical replacement of the top-level "version" line — preserves file formatting
python3 - "$NEW" <<'EOF'
import re, sys
raw = open('package.json').read()
new, n = re.subn(r'("version":\s*")[^"]+(")', lambda m: m.group(1) + sys.argv[1] + m.group(2), raw, count=1)
assert n == 1, 'version field not found'
open('package.json', 'w').write(new)
EOF

git add package.json
git commit -m "release: v$NEW"
git tag -a "v$NEW" -m "v$NEW"
git push origin main "refs/tags/v$NEW"
echo "released v$NEW ($(git rev-parse --short HEAD)) — pin consumers with bump-libs.sh"

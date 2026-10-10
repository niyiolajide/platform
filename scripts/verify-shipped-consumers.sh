#!/bin/sh
# verify-shipped-consumers.sh — prove the SHIPPED @niyi/platform tarball serves
# separate ESLint 8.57.1 / 9.39.5 consumers through the real CLI.
#
# Run inside Docker node:22-alpine with npm 12.0.1 (CI and local alike):
#   docker run --rm -v "$(pwd):/repo" -w /repo node:22-alpine \
#     sh -c "npm install -g npm@12.0.1 && sh scripts/verify-shipped-consumers.sh"
#
# What it does (no --force, no --legacy-peer-deps, no mocked configs):
#   1. `npm pack` the library; assert the tarball ships eslint-v8/v9 entries.
#   2. Install the tarball into two isolated consumer dirs pinned to exact
#      eslint 8.57.1 vs 9.39.5 (prod deps only, as real consumers resolve).
#   3. Import the actual `./eslint/v8` / `./eslint/v9` subpath exports from
#      the installed tarball (never from source).
#   4. Run the real `eslint` CLI on synthetic positive/negative fixtures for
#      security / scheduler / design / typed / Next / client-secret and assert
#      the expected ruleIds. Prints count-only per-file lines.
#
# Correctness notes: every npm/tar step captures its full log to a file and
# checks the underlying exit status explicitly before printing any summary —
# no `| tail` / `| head` pipeline is allowed to mask the real exit. Only the
# script-created private tempdir is ever removed; $SHIPPED_WORKDIR (when set)
# is used only as a parent for a fresh mktemp dir, never removed itself.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -n "${SHIPPED_WORKDIR:-}" ]; then
  mkdir -p "$SHIPPED_WORKDIR"
  WORK="$(mktemp -d "${SHIPPED_WORKDIR}/shipped-consumers.XXXXXX")"
  TMPROOT="$WORK"
else
  TMPROOT="$(mktemp -d)"
  WORK="$TMPROOT/shipped-consumers"
  mkdir -p "$WORK"
fi
cleanup() { rm -rf "$TMPROOT"; }
trap cleanup EXIT INT TERM

(cd "$ROOT" && npm pack --pack-destination "$WORK" >"$WORK/pack.log" 2>&1)
PACK_STATUS=$?
if [ "$PACK_STATUS" -ne 0 ]; then echo "FAIL: npm pack exit $PACK_STATUS"; cat "$WORK/pack.log"; exit 1; fi
echo "pack: $(tail -n 1 "$WORK/pack.log")"
TARBALL="$(ls "$WORK"/niyi-platform-*.tgz 2>/dev/null)" || { echo "FAIL: no packed tarball in $WORK"; cat "$WORK/pack.log"; exit 1; }
[ -f "$TARBALL" ] || { echo "FAIL: no packed tarball in $WORK"; exit 1; }
tar -tzf "$TARBALL" >"$WORK/tar-list.txt" 2>"$WORK/tar-err.log"
TAR_STATUS=$?
if [ "$TAR_STATUS" -ne 0 ]; then echo "FAIL: tar list exit $TAR_STATUS"; cat "$WORK/tar-err.log"; exit 1; fi
for f in eslint-v8.mjs eslint-v9.mjs eslint-config.mjs package.json; do
  grep -q "package/$f" "$WORK/tar-list.txt" || { echo "FAIL: tarball missing $f"; exit 1; }
done
echo "packaging: eslint-v8/v9 + config + package.json present in $(basename "$TARBALL")"

check_engine() {
  ENG="$1"
  if [ "$ENG" = "8" ]; then ESLINT_VER="8.57.1"; SUBPATH="eslint/v8"; else ESLINT_VER="9.39.5"; SUBPATH="eslint/v9"; fi
  DIR="$WORK/consumer$ENG"
  mkdir -p "$DIR/src/lib" "$DIR/src/worker" "$DIR/src/components" "$DIR/src/typed"
  cp "$TARBALL" "$DIR/platform.tgz"
  cat > "$DIR/package.json" <<EOF
{"name":"shipped-consumer$ENG","private":true,"type":"module","version":"1.0.0",
 "dependencies":{"@niyi/platform":"file:./platform.tgz"},
 "devDependencies":{"eslint":"$ESLINT_VER","typescript":"5.6.3"}}
EOF
  printf "import v from '@niyi/platform/%s';\n\nexport default v;\n" "$SUBPATH" > "$DIR/eslint.config.mjs"
  printf '{"compilerOptions":{"allowJs":true,"checkJs":false,"jsx":"react-jsx","module":"nodenext","moduleResolution":"nodenext","noEmit":true,"strict":true,"target":"es2022"},"include":["eslint.config.mjs","src/**/*.ts","src/**/*.tsx","src/**/*.js","src/**/*.jsx","src/**/*.mjs"]}\n' > "$DIR/tsconfig.json"
  FX="$ROOT/test/fixtures/eslint-compat"
  cp "$FX/bad-eval.js" "$DIR/src/lib/evaluate.js"
  cp "$FX/bad-widget.jsx" "$DIR/src/components/Badge.jsx"
  cp "$FX/good-widget.jsx" "$DIR/src/components/BadgeGood.jsx"
  cp "$FX/bad-media.jsx" "$DIR/src/components/Hero.jsx"
  cp "$FX/bad-client.jsx" "$DIR/src/components/Loader.jsx"
  cp "$FX/bad-typed.ts" "$DIR/src/typed/bad-typed.ts"
  cp "$FX/good-typed.ts" "$DIR/src/typed/good-typed.ts"
  printf "import cron from 'node-cron';\n\ncron.schedule('* * * * *', () => {});\n" > "$DIR/src/worker/scheduler.ts"
  printf 'function updateHeartbeat(): void {}\n\nsetInterval(updateHeartbeat, 1000);\n' > "$DIR/src/worker/heartbeat.ts"
  printf 'export const out = 2 + 2;\n' > "$DIR/src/lib/clean.js"
  printf "'use client';\n\nconst appId = process.env.NEXT_PUBLIC_APP_ID;\n\nexport function show(): string | undefined {\n  return appId;\n}\n" > "$DIR/src/components/LoaderGood.jsx"

  (cd "$DIR" && npm install --no-audit --no-fund >"$DIR/install.log" 2>&1)
  INSTALL_STATUS=$?
  tail -n 3 "$DIR/install.log"
  if [ "$INSTALL_STATUS" -ne 0 ]; then echo "FAIL: consumer$ENG npm install exit $INSTALL_STATUS"; exit 1; fi
  grep -q "ERESOLVE" "$DIR/install.log" && { echo "FAIL: consumer$ENG peer resolution (ERESOLVE)"; exit 1; }
  (cd "$DIR" && npm ls --depth=0 >"$DIR/ls.log" 2>&1)
  LS_STATUS=$?
  head -n 6 "$DIR/ls.log"
  if [ "$LS_STATUS" -ne 0 ]; then echo "FAIL: consumer$ENG npm ls exit $LS_STATUS"; cat "$DIR/ls.log"; exit 1; fi
  ESLINT_CLI_VER="$(cd "$DIR" && ./node_modules/.bin/eslint --version 2>"$DIR/version-err.log")"
  VER_STATUS=$?
  if [ "$VER_STATUS" -ne 0 ]; then echo "FAIL: consumer$ENG eslint --version exit $VER_STATUS"; cat "$DIR/version-err.log"; exit 1; fi
  if [ "$ESLINT_CLI_VER" != "v$ESLINT_VER" ]; then echo "FAIL: consumer$ENG eslint CLI version mismatch: got $ESLINT_CLI_VER want v$ESLINT_VER"; exit 1; fi
  echo "consumer$ENG eslint CLI version $ESLINT_CLI_VER exact"
  (cd "$DIR" && node --input-type=module -e "import v from '@niyi/platform/$SUBPATH'; console.log('consumer$ENG subpath $SUBPATH blocks: ' + v.length);") \
    || { echo "FAIL: consumer$ENG subpath import"; exit 1; }
  (cd "$DIR" && node --input-type=module -e "import v8 from '@niyi/platform/eslint/v8'; import v9 from '@niyi/platform/eslint/v9'; if (!Array.isArray(v8) || !Array.isArray(v9) || v8.length === 0 || v9.length === 0) { throw new Error('empty versioned blocks'); } console.log('consumer$ENG packaging imports eslint/v8:' + v8.length + ' eslint/v9:' + v9.length);") \
    || { echo "FAIL: consumer$ENG v8/v9 packaging imports"; exit 1; }

  if [ "$ENG" = "8" ]; then export ESLINT_USE_FLAT_CONFIG=true; fi
  (cd "$DIR" && node --input-type=module -e "
import { execFileSync } from 'node:child_process';
const files = ['src/lib/evaluate.js','src/lib/clean.js','src/worker/scheduler.ts','src/worker/heartbeat.ts','src/components/Badge.jsx','src/components/BadgeGood.jsx','src/components/Hero.jsx','src/components/Loader.jsx','src/components/LoaderGood.jsx','src/typed/bad-typed.ts','src/typed/good-typed.ts'];
const need = {
  'src/lib/evaluate.js': ['no-eval', 'security/detect-eval-with-expression'],
  'src/lib/clean.js': [],
  'src/worker/scheduler.ts': ['pulse/no-app-local-scheduler'],
  'src/worker/heartbeat.ts': [],
  'src/components/Badge.jsx': ['no-restricted-syntax', 'no-restricted-syntax'],
  'src/components/BadgeGood.jsx': [],
  'src/components/Hero.jsx': ['@next/next/no-img-element'],
  'src/components/Loader.jsx': ['pulse/no-client-server-secret-access'],
  'src/components/LoaderGood.jsx': [],
  'src/typed/bad-typed.ts': ['@typescript-eslint/await-thenable', '@typescript-eslint/no-floating-promises'],
  'src/typed/good-typed.ts': [],
};
let fail = 0;
function lint(f) {
  try {
    return execFileSync('./node_modules/.bin/eslint', ['--format', 'json', f], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    if (e && e.stdout) return e.stdout;
    throw e;
  }
}
for (const f of files) {
  const raw = lint(f);
  const ids = JSON.parse(raw)[0].messages.map((m) => m.ruleId);
  const want = need[f];
  const ok = want.length === 0 ? ids.length === 0 : want.every((w, i) => ids.filter((x) => x === w).length >= want.filter((x) => x === w).length && ids.includes(w));
  console.log('consumer$ENG ' + f + ' => ' + ids.length + ' [' + ids.join(',') + ']' + (ok ? '' : '  MISMATCH'));
  if (!ok) fail = 1;
}
process.exit(fail);
") || { echo "FAIL: consumer$ENG CLI matrix"; exit 1; }
  if [ "$ENG" = "8" ]; then unset ESLINT_USE_FLAT_CONFIG; fi
  echo "consumer$ENG (eslint $ESLINT_VER): shipped CLI matrix green"
}

check_engine 8
check_engine 9
echo "shipped 8/9 consumer verification green"

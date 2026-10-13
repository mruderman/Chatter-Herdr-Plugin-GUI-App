#!/bin/sh
# Rebuilds a Chatter that is byte-identical, in the four files that matter, to the one on production
# (baremetalcyansociety): upstream 0.19.0 at commit 0edc18f plus the local dist patches in prod-dist.diff,
# which were read over SSH on 2026-10-13. Usage: rebuild.sh [DIR]   (default ~/src/chatter-prod)
# Prints the path to dist/bin/chatter.js on success. It never touches an existing checkout that does not match.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
DIR=${1:-$HOME/src/chatter-prod}
COMMIT=0edc18f4a130a6e013b24f9090b07372c8c41feb
if [ ! -d "$DIR/.git" ]; then
  git clone --quiet https://github.com/marcvermeeren/chatter.git "$DIR"
  git -C "$DIR" checkout --quiet "$COMMIT"
  git -C "$DIR" apply "$HERE/prod-dist.diff"
fi
[ "$(git -C "$DIR" rev-parse HEAD)" = "$COMMIT" ] || { echo "rebuild.sh: $DIR is not at $COMMIT" >&2; exit 1; }
(cd "$DIR" && sha256sum --check --quiet "$HERE/EXPECTED_SHA256") || { echo "rebuild.sh: $DIR does not match production's files" >&2; exit 1; }
echo "$DIR/dist/bin/chatter.js"

#!/bin/sh
# Builds the web client the way a release is built: from the lockfile, with no install scripts, and it
# reports success only after check:dist has passed. Safe to run again: the same commit gives the same index.html.
#
#   deploy/build-client.sh
#   RELEASES_DIR=~/chatter-bridge/releases deploy/build-client.sh
#
# With RELEASES_DIR set, the build is also copied to $RELEASES_DIR/<git-sha>/dist and $RELEASES_DIR/current is
# pointed at that release. Point CHATTER_BRIDGE_STATIC_DIR at $RELEASES_DIR/current/dist. It never restarts
# anything: the bridge resolves the static root's realpath once, at start, so a moved symlink needs a restart.
set -eu

step='starting'
tmp_release=''
tmp_link=''
cleanup() {
  status=$?
  [ -z "$tmp_release" ] || rm -rf "$tmp_release"
  [ -z "$tmp_link" ] || rm -f "$tmp_link"
  if [ "$status" -ne 0 ]; then
    echo "build-client: FAILED while: $step (exit $status)" >&2
  fi
  exit "$status"
}
trap cleanup EXIT

die() { echo "build-client: $*" >&2; exit 1; }

# Resolved from the script's own path, so it works from any current directory and through a symlink to the repo.
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
CLIENT=$ROOT/client
DIST=$CLIENT/dist
RELEASES=${RELEASES_DIR:-}

# One variable at a time, so that a failing tool fails the script (a pipeline into cut would hide it).
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then out=$(sha256sum "$1")
  elif command -v shasum >/dev/null 2>&1; then out=$(shasum -a 256 "$1")
  else echo 'build-client: needs sha256sum or shasum on PATH' >&2; return 1
  fi
  printf '%s\n' "${out%% *}"
}

# rename(2) through node, which every host of this project has: unlike `mv`, it never moves a directory into
# an existing one, and the swap of a symlink is atomic on every platform (`ln -sfn` is unlink then symlink).
rename_path() {
  node -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' "$1" "$2"
}

git_revision() {
  sha=$(git -C "$ROOT" rev-parse --short=12 HEAD 2>/dev/null) || return 1
  # Untracked files count: a new source file changes the build as much as an edited one. If git cannot tell, say dirty.
  if changes=$(git -C "$ROOT" status --porcelain 2>/dev/null) && [ -z "$changes" ]; then
    printf '%s\n' "$sha"
  else
    printf '%s-dirty\n' "$sha"
  fi
}

# Fail before the build, not after it, when a release cannot be named.
if [ -n "$RELEASES" ]; then
  step='checking that the commit can be named'
  git -C "$ROOT" rev-parse --short=12 HEAD >/dev/null 2>&1 || die "RELEASES_DIR needs a git checkout to name the release by its commit"
fi

step='npm ci'
# The flag repeats client/.npmrc on purpose: an npm_config_ignore_scripts in the environment outranks that file.
npm --prefix "$CLIENT" ci --ignore-scripts
step='npm run build'
npm --prefix "$CLIENT" run build
step='npm run check:dist'
npm --prefix "$CLIENT" run check:dist

step='reading dist/index.html'
[ -f "$DIST/index.html" ] || die "$DIST/index.html is missing after the build"
index_hash=$(sha256_of "$DIST/index.html")

step='reading the git revision'
revision=unknown
if rev=$(git_revision); then revision=$rev; fi

release=''
if [ -n "$RELEASES" ]; then
  step='placing the release'
  mkdir -p "$RELEASES"
  RELEASES=$(CDPATH= cd -- "$RELEASES" && pwd -P)
  name=$revision
  # A dirty tree can be built again with other edits, and a release is never changed in place (a running bridge
  # may be serving it), so its name carries what it holds.
  case $revision in *-dirty) name=$revision-$(printf '%.8s' "$index_hash") ;; esac
  release=$RELEASES/$name
  if [ -e "$release" ]; then
    # The same commit, built again, must give the same files. If not, say so rather than replace what may be served.
    diff -rq "$DIST" "$release/dist" >/dev/null 2>&1 \
      || die "release $release exists and differs from this build; it is not changed (a bridge may be serving it). A clean commit should build identically, so find out why; remove that directory only if nothing serves it"
  else
    tmp_release=$RELEASES/.incoming.$$
    rm -rf "$tmp_release"
    mkdir "$tmp_release"
    cp -R "$DIST" "$tmp_release/dist"
    rename_path "$tmp_release" "$release"
    tmp_release=''
  fi
  step='moving the current symlink'
  # Relative, so the releases directory can be moved or backed up as one tree.
  tmp_link=$RELEASES/.current.$$
  rm -f "$tmp_link"
  ln -s "$name" "$tmp_link"
  rename_path "$tmp_link" "$RELEASES/current"
  tmp_link=''
fi

step='reporting'
echo "build-client: OK"
echo "revision: $revision"
echo "dist: $DIST"
echo "index.html sha256: $index_hash"
if [ -n "$release" ]; then
  echo "release: $release/dist"
  echo "current: $RELEASES/current -> $name"
  echo "note: the bridge resolves the static root's realpath once, at start. A running bridge keeps serving the release it started with: restart it (systemctl --user restart chatter-bridge) to serve the one current now points at."
fi

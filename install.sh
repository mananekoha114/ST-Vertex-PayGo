#!/bin/sh
# Portable entry point; installation logic lives in scripts/install.mjs.
set -u
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1
help=0
for arg do
    case "$arg" in --help|-h) help=1 ;; esac
done
node_ready() {
    command -v node >/dev/null 2>&1 &&
        node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' >/dev/null 2>&1
}
if ! node_ready; then
    if [ "$help" -eq 1 ]; then
        cat <<'EOF'
Usage: sh install.sh --host PATH [options]
Requires an existing host environment and Node.js 20 or newer.
Options: --host PATH, --branch NAME, --local-source PATH, --config PATH,
         --data-root PATH, --plugins-path PATH, --extensions-path PATH,
         --replace-modified, --dry-run, --help
EOF
        exit 0
    fi
    printf '%s\n' 'Node.js 20 or newer is required; use the existing host environment.' >&2
    exit 1
fi
exec node "$script_dir/scripts/install.mjs" "$@"

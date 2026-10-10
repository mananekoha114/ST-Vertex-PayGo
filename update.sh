#!/bin/sh
# Generated from bootstrap.sh by scripts/sync-update-launchers.mjs; do not edit directly.
(
# Keep the full implementation inside a function so truncated downloads cannot run it.
paygo_update() (
    for arg do
        case "$arg" in
            --help|-h)
                printf '%s\n' 'Usage: sh update.sh [update options]' 'Updates an existing PayGo installation. Requires Node.js 20+ and Git. PAYGO_HOST selects the host; PAYGO_BRANCH overrides the installed branch.' 'PAYGO_INSTALLER_REF selects the installer branch/tag (default: main).'
                exit 0 ;;
        esac
    done
    command -v node >/dev/null 2>&1 || { printf '%s\n' 'Node.js 20 or newer is required.' >&2; exit 1; }
    node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' </dev/null >/dev/null 2>&1 || { printf '%s\n' 'Node.js 20 or newer is required.' >&2; exit 1; }
    command -v git >/dev/null 2>&1 || { printf '%s\n' 'Git is required.' >&2; exit 1; }
    installer_ref=${PAYGO_INSTALLER_REF:-main}
    case "$installer_ref" in
        [!A-Za-z0-9]*|*..*|*[!A-Za-z0-9._/-]*) printf '%s\n' 'Invalid PAYGO_INSTALLER_REF.' >&2; exit 1 ;;
    esac
    [ -n "${HOME:-}" ] && [ -d "$HOME" ] || { printf '%s\n' 'An existing private HOME directory is required.' >&2; exit 1; }
    private_home=$(CDPATH= cd -- "$HOME" && pwd -P) || exit 1
    case "${PREFIX:-}" in
        */com.termux*/files/usr)
            case "$private_home" in
                /data/data/*/files/home|/data/user/[0-9]*/*/files/home) ;;
                *) printf '%s\n' 'Termux requires its private HOME directory.' >&2; exit 1 ;;
            esac ;;
    esac
    # A dedicated directory avoids the shared Android /tmp and storage locations.
    (umask 077; mkdir -p "$private_home/.cache/paygo-bootstrap") || exit 1
    temp_base=$(CDPATH= cd -- "$private_home/.cache/paygo-bootstrap" && pwd -P) || exit 1
    case "$temp_base" in "$private_home"/.cache/paygo-bootstrap) ;; *) printf '%s\n' 'Unsafe temporary directory.' >&2; exit 1 ;; esac
    temp_dir=$(umask 077; mktemp -d "$temp_base/run.XXXXXXXXXX") || exit 1
    cleanup() {
        status=$?
        trap - 0 HUP INT TERM
        case "$temp_dir" in
            "$temp_base"/run.*) [ -d "$temp_dir" ] && rm -rf -- "$temp_dir" ;;
        esac
        exit "$status"
    }
    trap cleanup 0
    trap 'exit 129' HUP
    trap 'exit 130' INT
    trap 'exit 143' TERM
    printf '%s\n' 'Downloading the PayGo updater...'
    git clone --depth 1 --single-branch --branch "$installer_ref" -- https://github.com/mananekoha114/ST-Vertex-PayGo.git "$temp_dir/source" </dev/null >/dev/null 2>&1 || { printf '%s\n' 'Unable to download the PayGo installer.' >&2; exit 1; }
    if ( : </dev/tty ) 2>/dev/null; then
        node "$temp_dir/source/scripts/install-online.mjs" --update "$@" </dev/tty
    else
        node "$temp_dir/source/scripts/install-online.mjs" --update "$@" </dev/null
    fi
    exit "$?"
)
paygo_update "$@"
)

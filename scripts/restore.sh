#!/bin/sh
set -eu

usage() {
    echo "Usage: CONFIRM_RESTORE=yes $0 DATABASE_INPUT [MEDIA_INPUT]" >&2
    exit 2
}

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)

compose() {
    if [ "${PRODUCTION_DEPLOYMENT:-}" = "yes" ]; then
        sh "$root/scripts/production-compose.sh" "$@"
    else
        docker compose "$@"
    fi
}

[ "$#" -ge 1 ] && [ "$#" -le 2 ] || usage
[ "${CONFIRM_RESTORE:-}" = "yes" ] || {
    echo "Restore is destructive; set CONFIRM_RESTORE=yes" >&2
    exit 2
}
input=$1
media_input=${2:-}
[ -s "$input" ] || {
    echo "Backup does not exist or is empty: $input" >&2
    exit 1
}
if [ -n "$media_input" ]; then
    [ -s "$media_input" ] || {
        echo "Media backup does not exist or is empty: $media_input" >&2
        exit 1
    }
    compose run --rm -T --no-deps resolvate \
        python -m resolvate.media_archive validate < "$media_input"
fi

compose exec -T postgres pg_restore --list < "$input" >/dev/null

application_stopped=false
restore_exit() {
    status=$?
    trap - EXIT HUP INT TERM
    if [ "$application_stopped" = true ] && [ "$status" -ne 0 ]; then
        echo "Restore failed; Resolvate remains stopped for manual verification" >&2
    fi
    exit "$status"
}
trap restore_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

compose stop resolvate
application_stopped=true

if [ "${RESOLVATE_RESTORE_FAILURE_INJECTION:-}" = "after_stop" ]; then
    [ "${CONFIRM_RESTORE_FAILURE_INJECTION:-}" = "yes" ] || {
        echo "Restore failure injection requires CONFIRM_RESTORE_FAILURE_INJECTION=yes" >&2
        exit 2
    }
    echo "Injected restore failure after application stop" >&2
    exit 97
fi

compose exec -T postgres sh -eu -c \
    'PGPASSWORD="$POSTGRES_MIGRATION_PASSWORD" pg_restore --clean --if-exists --exit-on-error --no-owner --no-acl --username="$POSTGRES_MIGRATION_USER" --dbname="$POSTGRES_DB"' \
    < "$input"

if [ -n "$media_input" ]; then
    compose run --rm -T --no-deps resolvate \
        python -m resolvate.media_archive restore < "$media_input"
fi

# The restored archive may be older than the running image. Remove the successful
# one-shot container so Compose must execute migrations again before Resolvate.
compose rm --force --stop postgres-migrate
compose up --detach --wait resolvate
application_stopped=false
trap - EXIT HUP INT TERM
echo "Restore completed; application is healthy"

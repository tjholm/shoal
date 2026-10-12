#!/bin/sh
# Applies pending database migrations, then runs the given command.
# SHOAL_SKIP_MIGRATIONS=true skips the migrations, for when a deploy step
# migrates or several instances share a database.
set -eu

case "${SHOAL_SKIP_MIGRATIONS:-false}" in
	false) bun packages/db/cli.ts migrate ;;
	true) echo "SHOAL_SKIP_MIGRATIONS=true: leaving the database schema as it is" ;;
	*)
		echo "SHOAL_SKIP_MIGRATIONS must be true or false" >&2
		exit 1
		;;
esac

exec "$@"

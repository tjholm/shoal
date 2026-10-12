#!/bin/sh
# Installs and starts shoal with Docker, in a `shoal` folder in the current
# directory:
#
#   curl -fsSL https://shoal.school/install.sh | sh
#
# Safe to run again: an existing compose.yml and .env are kept, so the secret
# that signs people in never changes under an installation.
set -eu

COMPOSE_URL="https://shoal.school/compose.yml"
INSTALL_DIR="shoal"
APP_URL="http://localhost:3000"
HEALTH_URL="$APP_URL/api/healthz"
# How long to wait for the first start, which downloads images and migrates the database.
STARTUP_TIMEOUT_SECONDS=120

fail() {
	echo "shoal: $1" >&2
	exit 1
}

# 32 random bytes, base64-encoded, as `openssl rand -base64 32` prints them.
random_key() {
	head -c 32 /dev/urandom | base64 | tr -d '\n'
}

command -v curl >/dev/null 2>&1 || fail "curl is required."
command -v docker >/dev/null 2>&1 ||
	fail "Docker is required. Install it from https://docs.docker.com/get-docker/"
docker compose version >/dev/null 2>&1 ||
	fail "Docker Compose is required. It comes with Docker Desktop, or see https://docs.docker.com/compose/install/"

mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

if [ -f compose.yml ]; then
	echo "Keeping the existing $INSTALL_DIR/compose.yml"
else
	curl -fsSL "$COMPOSE_URL" -o compose.yml
fi

if [ -f .env ]; then
	echo "Keeping the existing $INSTALL_DIR/.env"
else
	(
		umask 077
		{
			printf 'BETTER_AUTH_SECRET=%s\n' "$(random_key)"
			echo "# Where your browser and workers reach shoal. Change it to this machine's"
			echo "# network address (e.g. http://192.168.1.10:3000) for workers on other machines."
			echo "SHOAL_URL=$APP_URL"
		} >.env
	)
	echo "Wrote $INSTALL_DIR/.env with a new secret. Back it up and keep it private."
fi

docker compose up -d

printf 'Waiting for shoal to start'
waited=0
until curl -fs "$HEALTH_URL" >/dev/null 2>&1; do
	if [ "$waited" -ge "$STARTUP_TIMEOUT_SECONDS" ]; then
		echo
		fail "shoal didn't start in time. See what it printed with: cd $INSTALL_DIR && docker compose logs shoal"
	fi
	printf '.'
	sleep 2
	waited=$((waited + 2))
done
echo

echo "shoal is running at $APP_URL"
echo "Open it and create your account: the first one owns the install."
echo "Workers on other machines need SHOAL_URL in $INSTALL_DIR/.env set to this machine's"
echo "network address. Change it, then run: cd $INSTALL_DIR && docker compose up -d"

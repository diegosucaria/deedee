#!/bin/sh
# Web container entrypoint.
#
# The web service persists auth.json (login password hash + passkey
# public keys) on a Docker volume mounted at /app/data. Docker creates
# the volume mountpoint as root-owned, but Next.js runs as the unprivileged
# nextjs user (uid 1001). Without this script the bootstrap silently fails
# with EACCES on every boot and the /login page reports "No password
# configured" forever.
#
# This script runs as root on container start, ensures /app/data is owned
# by nextjs, then drops to that user before exec'ing Node. Fixes both
# fresh volumes AND existing volumes that were created with bad perms by
# a previous deploy.

set -e

DATA_DIR="${AUTH_DATA_DIR:-/app/data}"

if [ "$(id -u)" = "0" ]; then
    mkdir -p "$DATA_DIR"
    chown -R 1001:1001 "$DATA_DIR"
    chmod 700 "$DATA_DIR"
    exec su-exec 1001:1001 "$@"
fi

exec "$@"

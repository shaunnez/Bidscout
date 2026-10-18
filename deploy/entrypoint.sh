#!/bin/sh
# Hosts like Railway mount volumes owned by root. Start as root only long enough to hand
# the data directory to the unprivileged "node" user, then run the app as that user.
set -e
DATA_DIR="${BIDSCOUT_DATA_DIR:-/data}"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  if [ "$(stat -c %u "$DATA_DIR")" != "$(id -u node)" ]; then
    chown -R node:node "$DATA_DIR"
  fi
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"

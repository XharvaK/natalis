#!/bin/sh
# Waits for DNS to answer, so a booting unit does not start before the network is ready.
# It ends by a time deadline, not by a count of tries.
# Usage: wait-for-dns.sh HOST SECONDS. It never fails the unit.

host=$1
seconds=$2

[ -n "$host" ] || exit 0
case "$seconds" in "" | *[!0-9]*) exit 0 ;; esac
[ "$seconds" -gt 0 ] || exit 0

start=$(date +%s)
while [ "$(( $(date +%s) - start ))" -lt "$seconds" ]; do
  if timeout 3 getent hosts "$host" >/dev/null 2>&1; then
    exit 0
  fi
  if [ "$(( $(date +%s) - start ))" -lt "$seconds" ]; then
    sleep 1
  fi
done

echo "natalis: DNS for $host not ready after $seconds s; starting anyway" >&2
exit 0

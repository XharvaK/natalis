#!/bin/sh
# Waits for DNS to answer, so a booting unit does not start before the network is ready.
# Usage: wait-for-dns.sh HOST SECONDS. It never fails the unit.

host=$1
seconds=$2

[ -n "$host" ] || exit 0
case "$seconds" in "" | *[!0-9]*) exit 0 ;; esac
[ "$seconds" -gt 0 ] || exit 0

tries=0
while [ "$tries" -lt "$seconds" ]; do
  if getent hosts "$host" >/dev/null 2>&1; then
    exit 0
  fi
  tries=$((tries + 1))
  [ "$tries" -lt "$seconds" ] && sleep 1
done

echo "natalis: DNS for $host not ready after $seconds s; starting anyway" >&2
exit 0

#!/bin/sh
# Installs an unpacked release in place as the simulation (run as root from its folder, which is
# /opt/agentsim in the image): everything root-owned and read-only to other users, the sudoers
# entry for the session user's helpers, and the simulation user's home. The engines and the users
# come with the image.
set -eu
APP=$(cd "$(dirname "$0")" && pwd)
[ "$(id -u)" = 0 ] || { echo "install.sh must run as root" >&2; exit 1; }
id agentsim >/dev/null 2>&1 || { echo "the agentsim user is missing" >&2; exit 1; }

visudo -cf "$APP/sudoers" >/dev/null
install -m 0440 -o root -g root "$APP/sudoers" /etc/sudoers.d/agentsim
rm "$APP/sudoers"
chown -R root:root "$APP"
chmod -R go-w "$APP"
chmod 0755 "$APP"/bin/* "$APP"/scripts/*
mkdir -p /var/lib/agentsim/home
chown agentsim:agentsim /var/lib/agentsim/home

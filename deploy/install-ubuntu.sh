#!/usr/bin/env bash
# Installs files and starts only the loopback application. HTTPS activation is separate.
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo 'Run with sudo'; exit 1; }
[[ $(uname -m) == x86_64 ]] || { echo 'This package requires x86_64'; exit 1; }
: "${1:?Usage: install-ubuntu.sh /path/to/extracted/release}"
release_source=$(realpath "$1")
[[ -f "$release_source/server/index.mjs" && -f "$release_source/dist/index.html" ]]
# Do not overwrite an existing unrelated site/service.
if [[ -e /etc/caddy/Caddyfile && ! -f /opt/blotlens/managed-install ]]; then
  echo 'Existing Caddy config found; review and merge manually.'; exit 1
fi
if ! command -v caddy >/dev/null; then
  # Prevent package installation from publishing the default HTTP page.
  systemctl mask caddy.service
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq caddy ca-certificates curl xz-utils
fi
if [[ ! -x /opt/blotlens-node/bin/node ]]; then
  node_version=v24.14.1
  temp_node=$(mktemp -d)
  curl -fsSL "https://nodejs.org/dist/$node_version/node-$node_version-linux-x64.tar.xz" -o "$temp_node/node-$node_version-linux-x64.tar.xz"
  curl -fsSL "https://nodejs.org/dist/$node_version/SHASUMS256.txt" -o "$temp_node/SHASUMS256.txt"
  (cd "$temp_node"; grep " node-$node_version-linux-x64.tar.xz$" SHASUMS256.txt | sha256sum -c -)
  mkdir -p /opt/blotlens-node
  tar -xJf "$temp_node/node-$node_version-linux-x64.tar.xz" -C /opt/blotlens-node --strip-components=1
  rm -rf "$temp_node"
fi
id blotlens >/dev/null 2>&1 || useradd --system --home /nonexistent --shell /usr/sbin/nologin blotlens
release_id=$(date -u +%Y%m%dT%H%M%SZ)
release_dir="/opt/blotlens/releases/$release_id"
mkdir -p "$release_dir"
cp -a "$release_source/." "$release_dir/"
chown -R root:root "$release_dir"
chmod -R a+rX "$release_dir"
if [[ -L /opt/blotlens/current ]]; then readlink /opt/blotlens/current > /opt/blotlens/previous-release; fi
ln -sfn "$release_dir" /opt/blotlens/current
install -m 644 "$release_dir/deploy/blotlens.service" /etc/systemd/system/blotlens.service
# Stage the site; do not activate HTTPS until DNS and public access have been approved.
install -m 644 "$release_dir/deploy/Caddyfile" /etc/caddy/Caddyfile.blotlens-ready
caddy validate --config /etc/caddy/Caddyfile.blotlens-ready --adapter caddyfile
systemctl daemon-reload
systemctl enable blotlens
systemctl restart blotlens
sleep 2
curl -fsS -H 'Host: blotlens.top' http://127.0.0.1:4317/api/config
touch /opt/blotlens/managed-install
printf '\nPREPARED: loopback app ready; HTTPS not yet activated.\n'

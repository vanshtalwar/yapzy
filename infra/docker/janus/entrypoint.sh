#!/bin/sh
# Renders the Janus configuration from environment variables, then starts Janus.
#
#   JANUS_ADMIN_SECRET    Admin API secret and VideoRoom admin_key (required)
#   JANUS_TOKEN_SECRET    HMAC secret for signed tokens (required)
#   JANUS_PUBLIC_IP       address advertised in ICE candidates (nat_1_1_mapping), default 127.0.0.1
#   JANUS_RTP_PORT_RANGE  UDP media ports, published 1:1 by Compose, default 20000-20100
#   JANUS_DEBUG_LEVEL     0-7, default 4 (info)
#   JANUS_NODE_ID         server name shown by the info request, default janus
#
# Values end up inside quoted jcfg strings, so they are restricted to characters that can't
# break out of them.
set -eu

fail() {
  echo "janus entrypoint: $*" >&2
  exit 64
}

check() {
  name=$1
  pattern=$2
  eval "value=\${$name:-}"
  [ -n "$value" ] || fail "$name is required"
  printf '%s' "$value" | grep -Eq "^($pattern)\$" || fail "$name has an invalid value"
}

: "${JANUS_PUBLIC_IP:=127.0.0.1}"
: "${JANUS_RTP_PORT_RANGE:=20000-20100}"
: "${JANUS_DEBUG_LEVEL:=4}"
: "${JANUS_NODE_ID:=janus}"
export JANUS_PUBLIC_IP JANUS_RTP_PORT_RANGE JANUS_DEBUG_LEVEL JANUS_NODE_ID

check JANUS_ADMIN_SECRET '[A-Za-z0-9_-]{16,128}'
check JANUS_TOKEN_SECRET '[A-Za-z0-9_-]{16,128}'
check JANUS_PUBLIC_IP '[0-9A-Fa-f.:]{2,45}(,[0-9A-Fa-f.:]{2,45})*'
check JANUS_RTP_PORT_RANGE '[0-9]{4,5}-[0-9]{4,5}'
check JANUS_DEBUG_LEVEL '[0-7]'
check JANUS_NODE_ID '[A-Za-z0-9_-]{1,64}'

conf=/opt/janus/etc/janus
variables='${JANUS_ADMIN_SECRET} ${JANUS_TOKEN_SECRET} ${JANUS_PUBLIC_IP} ${JANUS_RTP_PORT_RANGE} ${JANUS_DEBUG_LEVEL} ${JANUS_NODE_ID}'
for template in /opt/janus/templates/*.jcfg.template; do
  name=$(basename "$template" .template)
  envsubst "$variables" < "$template" > "$conf/$name"
done
chmod 600 "$conf"/*.jcfg

exec /opt/janus/bin/janus --configs-folder="$conf" --config="$conf/janus.jcfg"

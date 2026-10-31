# Janus WebRTC server (VideoRoom SFU) for group video calls — Part 11.
#
# There is no official image, so Janus is built from a pinned release tag with only what we
# use: the core, the VideoRoom plugin and the WebSocket transport (client API 8188, Admin API
# 7188). HTTP/REST, data channels, every other plugin, event handlers and loggers are left out.
# Every dependency is pinned to a tag whose commit hash (or tarball checksum) is verified, so a
# moved tag fails the build instead of silently changing what we run.
#
# Build:  docker compose --env-file .env -f infra/docker/docker-compose.yml build janus
# Config: rendered from conf/*.template at start by entrypoint.sh (see there for variables).

ARG DEBIAN_IMAGE=debian:trixie-20261020-slim

FROM ${DEBIAN_IMAGE} AS build

ARG JANUS_VERSION=v1.4.3
ARG JANUS_COMMIT=1f0b75cac1c9ad819ee4c2a905a2c65b00b82cde
ARG LIBNICE_VERSION=0.1.24
ARG LIBNICE_COMMIT=af62014d520ac09c8fe1974bda1b253114c68843
ARG LIBSRTP_VERSION=v2.8.1
ARG LIBSRTP_COMMIT=6ff02afa8d2dc3f2e8896af391d137c1c66ff6fa
ARG LWS_VERSION=v4.3.10
ARG LWS_COMMIT=2288cf200bc1c28680765bd4f07e437356106c2d
ARG JANSSON_VERSION=2.14.1
ARG JANSSON_SHA256=2521cd51a9641d7a4e457f7215a4cd5bb176f690bc11715ddeec483e85d9e2b3
ARG LIBCONFIG_VERSION=1.7.3
ARG LIBCONFIG_SHA256=545166d6cac037744381d1e9cc5a5405094e7bfad16a411699bcff40bbb31ee7

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    autoconf automake build-essential ca-certificates cmake curl gengetopt git libglib2.0-dev \
    libssl-dev libtool libzstd-dev meson ninja-build pkg-config zlib1g-dev \
  && rm -rf /var/lib/apt/lists/*

ENV PKG_CONFIG_PATH=/usr/local/lib/pkgconfig
WORKDIR /src

# git clone a tag and refuse to build if it no longer points at the expected commit.
RUN printf '%s\n' '#!/bin/sh' 'set -eu' \
    'git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$2" "$1" "$4"' \
    'actual=$(git -C "$4" rev-parse HEAD)' \
    '[ "$actual" = "$3" ] || { echo "tag $2 of $1 is $actual, expected $3" >&2; exit 1; }' \
    > /usr/local/bin/clone-pinned \
  && chmod +x /usr/local/bin/clone-pinned

RUN curl -fsSLo jansson.tar.gz \
    "https://github.com/akheron/jansson/releases/download/v${JANSSON_VERSION}/jansson-${JANSSON_VERSION}.tar.gz" \
  && echo "${JANSSON_SHA256}  jansson.tar.gz" | sha256sum -c - \
  && tar xzf jansson.tar.gz && cd "jansson-${JANSSON_VERSION}" \
  && ./configure --prefix=/usr/local --disable-static \
  && make -j"$(nproc)" && make install

RUN curl -fsSLo libconfig.tar.gz \
    "https://github.com/hyperrealm/libconfig/releases/download/v${LIBCONFIG_VERSION}/libconfig-${LIBCONFIG_VERSION}.tar.gz" \
  && echo "${LIBCONFIG_SHA256}  libconfig.tar.gz" | sha256sum -c - \
  && tar xzf libconfig.tar.gz && cd "libconfig-${LIBCONFIG_VERSION}" \
  && ./configure --prefix=/usr/local --disable-static --disable-cxx --disable-examples --disable-tests \
  && make -j"$(nproc)" && make install

RUN clone-pinned https://gitlab.freedesktop.org/libnice/libnice.git "${LIBNICE_VERSION}" "${LIBNICE_COMMIT}" libnice \
  && cd libnice \
  && meson setup build --prefix=/usr/local --libdir=lib --buildtype=release \
    -Dcrypto-library=openssl -Dexamples=disabled -Dtests=disabled -Dgtk_doc=disabled \
    -Dgstreamer=disabled -Dgupnp=disabled -Dintrospection=disabled \
  && ninja -C build && ninja -C build install

# --enable-openssl: AES-GCM SRTP profiles (Janus refuses to start without the symbols).
RUN clone-pinned https://github.com/cisco/libsrtp.git "${LIBSRTP_VERSION}" "${LIBSRTP_COMMIT}" libsrtp \
  && cd libsrtp \
  && ./configure --prefix=/usr/local --enable-openssl --disable-pcap \
  && make -j"$(nproc)" shared_library && make install

# Same options as Janus's own CI (LWS_MAX_SMP=1: Janus drives the service loop from one thread).
RUN clone-pinned https://github.com/warmcat/libwebsockets.git "${LWS_VERSION}" "${LWS_COMMIT}" libwebsockets \
  && cmake -S libwebsockets -B libwebsockets/build -DCMAKE_INSTALL_PREFIX=/usr/local \
    -DCMAKE_BUILD_TYPE=Release -DLWS_MAX_SMP=1 -DLWS_WITHOUT_EXTENSIONS=OFF \
    -DLWS_ROLE_RAW_FILE=OFF -DLWS_WITH_HTTP2=OFF -DLWS_WITHOUT_TESTAPPS=ON \
    -DLWS_WITHOUT_TEST_CLIENT=ON -DLWS_WITHOUT_TEST_PING=ON -DLWS_WITHOUT_TEST_SERVER=ON \
    -DLWS_WITH_STATIC=OFF \
  && cmake --build libwebsockets/build -j"$(nproc)" && cmake --install libwebsockets/build

RUN clone-pinned https://github.com/meetecho/janus-gateway.git "${JANUS_VERSION}" "${JANUS_COMMIT}" janus \
  && cd janus && ./autogen.sh \
  && ./configure --prefix=/opt/janus \
    --disable-docs --disable-data-channels --disable-turn-rest-api --disable-post-processing \
    --disable-all-plugins --enable-plugin-videoroom \
    --disable-all-transports --enable-websockets \
    --disable-all-handlers --disable-all-loggers \
  && make -j"$(nproc)" && make install \
  && rm -rf /opt/janus/include /opt/janus/share \
  && find /opt/janus/lib -name '*.la' -delete

FROM ${DEBIAN_IMAGE}

RUN apt-get update \
  && apt-get install -y --no-install-recommends gettext-base libglib2.0-0t64 libssl3t64 zlib1g \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system janus && useradd --system --gid janus --home-dir /opt/janus janus

COPY --from=build /usr/local/lib/ /usr/local/lib/
COPY --from=build /opt/janus /opt/janus
RUN rm -rf /usr/local/lib/pkgconfig /usr/local/lib/cmake && find /usr/local/lib -name '*.la' -delete \
  && ldconfig \
  && mkdir -p /opt/janus/etc/janus && chown janus:janus /opt/janus/etc/janus

COPY conf/ /opt/janus/templates/
COPY --chmod=0755 entrypoint.sh /opt/janus/bin/entrypoint.sh

USER janus
# 8188 Janus API (browsers), 7188 Admin API (backend only — never publish it publicly).
EXPOSE 8188 7188
# A TCP check only: the gateway's health checker does the authenticated Admin API probe.
HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=10 \
  CMD bash -c 'exec 3<>/dev/tcp/127.0.0.1/8188 && exec 4<>/dev/tcp/127.0.0.1/7188'
ENTRYPOINT ["/opt/janus/bin/entrypoint.sh"]

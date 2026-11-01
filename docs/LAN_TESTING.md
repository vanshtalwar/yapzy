# Testing on phones and other devices (LAN)

Video chat needs `getUserMedia`, which browsers only allow in a **secure context**: `https://`
pages or `http://localhost`. A phone that opens `http://192.168.1.20:3000` gets no camera (the
pre-join screen says "Video needs a secure connection"). Text chat works over plain http.

Below, `192.168.1.20` stands for your computer's LAN IP (`ipconfig getifaddr en0` on macOS).

## 1. Point every service at the LAN IP (both options)

In `.env` (all apps read it; real environment variables are **not** passed through `pnpm dev`,
because Turborepo runs tasks in strict env mode):

```bash
# Browser-facing URLs (use the https:// ones from option B if you use the proxy)
NEXT_PUBLIC_API_URL=http://192.168.1.20:4000
NEXT_PUBLIC_GATEWAY_URL=http://192.168.1.20:4001
# The API and the gateway only accept these browser origins
CORS_ORIGINS=http://localhost:3000,http://192.168.1.20:3000
# TURN: relay candidates and the URLs handed to browsers must be reachable from the phone
TURN_EXTERNAL_IP=192.168.1.20
TURN_HOST=192.168.1.20
STUN_URLS=stun:192.168.1.20:3478
# coturn listens on 127.0.0.1 only unless you opt in (it relays for anyone with credentials)
TURN_BIND_IP=0.0.0.0
# Janus (calls through the SFU, group calls): candidates and the browsers' Janus URL must be
# reachable from the phone. The Admin API (7188) stays on 127.0.0.1 regardless.
JANUS_PUBLIC_IP=192.168.1.20
JANUS_BIND_IP=0.0.0.0
JANUS_NODES=[{"id":"janus-1","wsUrl":"ws://192.168.1.20:8188","adminUrl":"ws://localhost:7188"}]
```

Then `pnpm infra:up` (coturn picks up `TURN_EXTERNAL_IP` and `TURN_BIND_IP`, Janus
`JANUS_PUBLIC_IP` and `JANUS_BIND_IP`) and restart `pnpm dev`. Behind the HTTPS proxy of option B,
Janus needs a `wss://` URL as well (proxy port 8188 like the gateway) — browsers refuse `ws://`
from an `https://` page. Set `TURN_BIND_IP` back to empty (or remove it) when you are done: even with the
relay restrictions in `turnserver.conf`, an open TURN server on a shared network is best avoided. The web dev
server accepts requests for the host in `NEXT_PUBLIC_GATEWAY_URL` (`allowedDevOrigins` in
`apps/web/next.config.mjs`), so its HMR and assets work from the LAN address.

## 2a. Option A — quickest: treat the LAN origin as secure (Chrome, Android)

On the phone (Chrome for Android) or another computer (desktop Chrome):

1. Open `chrome://flags/#unsafely-treat-insecure-origin-as-secure`.
2. Enter `http://192.168.1.20:3000`, enable the flag, relaunch Chrome.

The page now counts as a secure context and the camera works over plain http. Not available
in iOS Safari; use option B there.

## 2b. Option B — real HTTPS for all three origins (every device, incl. iOS)

The page, the API and the gateway must **all** be https (an https page cannot call
`http://…:4000` or `ws://…:4001` — mixed content is blocked), so
`next dev --experimental-https` alone is not enough. Put a local TLS reverse proxy in front of
the three dev servers, e.g. [Caddy](https://caddyserver.com) with its internal CA:

```caddyfile
# Caddyfile
{
	local_certs
}
https://192.168.1.20:3443 {
	reverse_proxy localhost:3000
}
https://192.168.1.20:4443 {
	reverse_proxy localhost:4000
}
https://192.168.1.20:4444 {
	reverse_proxy localhost:4001
}
```

```bash
caddy run --config Caddyfile
```

Use these values instead of the http ones from step 1:

```bash
NEXT_PUBLIC_API_URL=https://192.168.1.20:4443
NEXT_PUBLIC_GATEWAY_URL=https://192.168.1.20:4444
CORS_ORIGINS=http://localhost:3000,https://192.168.1.20:3443
# The proxy is the client's direct peer: trust its X-Forwarded-For so IP rate limits and
# IP bans see the phone's address, not 127.0.0.1.
TRUST_PROXY=127.0.0.1,::1
```

Install Caddy's root certificate on each device (`caddy trust` on the computer; on iOS send
the root certificate to the phone, install the profile, then enable it under Settings →
General → About → Certificate Trust Settings; on Android install it as a CA certificate) and
open `https://192.168.1.20:3443`. WebSockets (Socket.io and Next's HMR) work through the proxy.

## Notes

- Use `NEXT_PUBLIC_FORCE_TURN_RELAY=true` to check that calls work through coturn when the two
  devices cannot reach each other directly (and to see the cost of relaying).
- Relay ports `49160–49200/udp` and `3478` must not be blocked by the computer's firewall.
- Cloudflare Turnstile's test key works on any hostname; a real key must list the hostname.
- Headless Chrome on macOS hangs when it captures (even fake) audio; the automated browser
  checks synthesize the microphone with Web Audio. Real browsers are not affected.

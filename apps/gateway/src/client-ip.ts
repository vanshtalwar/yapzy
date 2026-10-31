import { type IncomingMessage } from 'node:http';

import proxyaddr from 'proxy-addr';

/**
 * Resolves the client IP with the same TRUST_PROXY semantics as the API: `false` = socket
 * address only, a number = trust that many proxy hops, a list = trust those proxies.
 */
export function createClientIpResolver(
  trustProxy: false | number | string[],
): (request: IncomingMessage) => string {
  const trust =
    trustProxy === false
      ? proxyaddr.compile([])
      : typeof trustProxy === 'number'
        ? (_address: string, hop: number) => hop < trustProxy
        : proxyaddr.compile(trustProxy);
  return (request) => proxyaddr(request, trust);
}

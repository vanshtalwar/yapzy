import { createHmac } from 'node:crypto';

export interface TurnCredentialsInput {
  visitorId: string;
  now: Date;
  secret: string;
  ttlSeconds: number;
  host: string;
  port: number;
  stunUrls: string[];
}

export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

/**
 * coturn "TURN REST API" credentials (use-auth-secret): username = "<expiry-unix>:<visitorId>",
 * credential = base64(HMAC-SHA1(TURN_SECRET, username)). coturn recomputes the HMAC and rejects
 * the username once the expiry has passed, so nothing is stored server-side.
 */
export function createTurnCredentials(input: TurnCredentialsInput): {
  iceServers: IceServer[];
  ttlSeconds: number;
} {
  const expiresAtUnix = Math.floor(input.now.getTime() / 1000) + input.ttlSeconds;
  const username = `${String(expiresAtUnix)}:${input.visitorId}`;
  const credential = createHmac('sha1', input.secret).update(username).digest('base64');
  const turnBase = `turn:${input.host}:${String(input.port)}`;

  return {
    iceServers: [
      { urls: input.stunUrls },
      {
        urls: [`${turnBase}?transport=udp`, `${turnBase}?transport=tcp`],
        username,
        credential,
      },
    ],
    ttlSeconds: input.ttlSeconds,
  };
}

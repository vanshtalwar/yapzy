import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

import { z } from 'zod';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Janus nodes and the admin secret the stack uses: the real environment wins over the root
 * .env, as for the services (the failover spec passes JANUS_NODES with a second node).
 */
export function janusNodes() {
  const env = parseEnv(readFileSync(path.join(ROOT, '.env'), 'utf8'));
  const nodes = z
    .array(z.object({ id: z.string(), wsUrl: z.string(), adminUrl: z.string() }))
    .parse(JSON.parse(process.env.JANUS_NODES ?? env.JANUS_NODES ?? '[]'));
  const secret = process.env.JANUS_ADMIN_SECRET ?? env.JANUS_ADMIN_SECRET;
  if (secret === undefined) throw new Error('JANUS_ADMIN_SECRET missing');
  return { nodes, secret };
}

/** One VideoRoom request through the Janus Admin API (the tests' view of the media server). */
async function videoroom(
  body: Record<string, unknown>,
  nodeIndex: number,
): Promise<Record<string, unknown>> {
  const { nodes, secret } = janusNodes();
  const node = nodes[nodeIndex];
  if (node === undefined) throw new Error(`no Janus node #${String(nodeIndex)}`);
  const ws = new WebSocket(node.adminUrl, 'janus-admin-protocol');
  try {
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    const reply = await new Promise<Record<string, unknown>>((resolve) => {
      ws.onmessage = (event) => {
        resolve(JSON.parse(String(event.data)) as Record<string, unknown>);
      };
      ws.send(
        JSON.stringify({
          janus: 'message_plugin',
          transaction: 'e2e',
          admin_secret: secret,
          plugin: 'janus.plugin.videoroom',
          request: { admin_key: secret, ...body },
        }),
      );
    });
    return (reply.response ?? {}) as Record<string, unknown>;
  } finally {
    ws.close();
  }
}

/** Publishers (participant ids) per Janus room right now, on node `nodeIndex`. */
export async function janusRooms(nodeIndex = 0): Promise<Map<number, string[]>> {
  const { list } = z
    .object({ list: z.array(z.object({ room: z.number() })) })
    .parse(await videoroom({ request: 'list' }, nodeIndex));
  const rooms = new Map<number, string[]>();
  for (const { room } of list) {
    const { participants } = z
      .object({
        participants: z.array(z.object({ display: z.string().optional(), publisher: z.boolean() })),
      })
      .parse(await videoroom({ request: 'listparticipants', room }, nodeIndex));
    rooms.set(
      room,
      participants.filter((p) => p.publisher).map((p) => p.display ?? ''),
    );
  }
  return rooms;
}

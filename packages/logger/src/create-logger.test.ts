import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { createLogger } from './create-logger.ts';

function captureStream() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      callback();
    },
  });
  return { lines, stream };
}

describe('createLogger', () => {
  it('writes JSON lines tagged with the service name', () => {
    const { lines, stream } = captureStream();
    createLogger({ service: 'api', destination: stream }).info({ visitorId: 'v1' }, 'hello');
    expect(lines[0]).toMatchObject({ service: 'api', visitorId: 'v1', msg: 'hello' });
  });

  it('redacts secrets and identifying data', () => {
    const { lines, stream } = captureStream();
    createLogger({ service: 'api', destination: stream }).info(
      {
        token: 'jwt',
        password: 'pw',
        ip: '203.0.113.1',
        auth: { token: 'nested' },
        req: { headers: { authorization: 'Bearer x', cookie: 'sid=1' } },
      },
      'request',
    );
    const line = JSON.stringify(lines[0]);
    for (const secret of ['jwt', 'pw', '203.0.113.1', 'nested', 'Bearer x', 'sid=1']) {
      expect(line).not.toContain(secret);
    }
    expect(line).toContain('[REDACTED]');
  });

  it('respects the configured level', () => {
    const { lines, stream } = captureStream();
    const logger = createLogger({ service: 'api', level: 'warn', destination: stream });
    logger.info('dropped');
    logger.warn('kept');
    expect(lines.map((line) => line.msg)).toEqual(['kept']);
  });
});

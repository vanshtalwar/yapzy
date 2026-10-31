import { randomUUID } from 'node:crypto';

import { createEnv, loadRootEnvFile, s3Env } from '@app/env';
import { afterAll, describe, expect, it } from 'vitest';

import { createMemoryObjectStore } from './memory.ts';
import { createObjectStore } from './s3.ts';

// Integration test against the dev MinIO (`pnpm infra:up`), under a throwaway prefix.
loadRootEnvFile();
const env = createEnv(s3Env, { service: 'storage-test' });
const store = createObjectStore({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  accessKeyId: env.S3_ACCESS_KEY,
  secretAccessKey: env.S3_SECRET_KEY,
});
const prefix = `test/${randomUUID()}`;

afterAll(() => {
  store.destroy();
});

describe.each([
  ['MinIO', store],
  ['memory', createMemoryObjectStore()],
])('object store (%s)', (_name, objects) => {
  it('puts, gets, copies and deletes objects', async () => {
    const body = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]);
    const key = `${prefix}/frame.jpg`;
    await objects.put(env.S3_BUCKET_FRAMES, key, body, 'image/jpeg');
    expect(await objects.get(env.S3_BUCKET_FRAMES, key)).toEqual(body);

    const copy = { bucket: env.S3_BUCKET_EVIDENCE, key: `${prefix}/copied frame.jpg` };
    await objects.copy({ bucket: env.S3_BUCKET_FRAMES, key }, copy);
    expect(await objects.get(copy.bucket, copy.key)).toEqual(body);

    await objects.delete(env.S3_BUCKET_FRAMES, key);
    await objects.delete(copy.bucket, copy.key);
    expect(await objects.get(env.S3_BUCKET_FRAMES, key)).toBeNull();
    expect(await objects.get(copy.bucket, copy.key)).toBeNull();
  });
});

import { type ObjectStore } from './s3.ts';

/** In-memory ObjectStore for tests (`objects` is exposed for assertions). */
export function createMemoryObjectStore() {
  const objects = new Map<string, { body: Uint8Array; contentType: string }>();
  const id = (bucket: string, key: string) => `${bucket}/${key}`;
  const store: ObjectStore & { objects: typeof objects } = {
    objects,
    put(bucket, key, body, contentType) {
      objects.set(id(bucket, key), { body: new Uint8Array(body), contentType });
      return Promise.resolve();
    },
    get(bucket, key) {
      return Promise.resolve(objects.get(id(bucket, key))?.body ?? null);
    },
    delete(bucket, key) {
      objects.delete(id(bucket, key));
      return Promise.resolve();
    },
    copy(from, to) {
      const source = objects.get(id(from.bucket, from.key));
      if (source === undefined) return Promise.reject(new Error(`missing ${from.key}`));
      objects.set(id(to.bucket, to.key), { ...source });
      return Promise.resolve();
    },
    destroy() {
      objects.clear();
    },
  };
  return store;
}

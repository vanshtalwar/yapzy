import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

export interface ObjectStoreConfig {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** The few S3 operations the app needs; MinIO in development, any S3-compatible store later. */
export interface ObjectStore {
  put(bucket: string, key: string, body: Uint8Array, contentType: string): Promise<void>;
  /** null if the object does not exist (e.g. a frame already expired). */
  get(bucket: string, key: string): Promise<Uint8Array | null>;
  delete(bucket: string, key: string): Promise<void>;
  copy(from: { bucket: string; key: string }, to: { bucket: string; key: string }): Promise<void>;
  destroy(): void;
}

export function createObjectStore(config: ObjectStoreConfig): ObjectStore {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    // MinIO (and most self-hosted S3) serve buckets as paths, not subdomains.
    forcePathStyle: true,
  });

  return {
    async put(bucket, key, body, contentType) {
      await client.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
      );
    },

    async get(bucket, key) {
      try {
        const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return result.Body === undefined ? null : await result.Body.transformToByteArray();
      } catch (error) {
        if (error instanceof NoSuchKey) return null;
        throw error;
      }
    },

    async delete(bucket, key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },

    async copy(from, to) {
      await client.send(
        new CopyObjectCommand({
          Bucket: to.bucket,
          Key: to.key,
          CopySource: `${from.bucket}/${encodeURIComponent(from.key).replaceAll('%2F', '/')}`,
        }),
      );
    },

    destroy() {
      client.destroy();
    },
  };
}

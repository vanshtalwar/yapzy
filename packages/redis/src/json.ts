import { type Redis } from 'ioredis';
import { type z } from 'zod';

/**
 * Raised when stored JSON is unparsable or fails its schema. The message carries only the key
 * (ids), never the stored value, which may contain chat content.
 */
export class RedisJsonError extends Error {
  readonly key: string;
  readonly field: string | undefined;

  constructor(key: string, field: string | undefined, cause: unknown) {
    super(`Invalid JSON in Redis at ${key}${field === undefined ? '' : ` [${field}]`}`, { cause });
    this.name = 'RedisJsonError';
    this.key = key;
    this.field = field;
  }
}

export function parseRedisJson<TSchema extends z.ZodType>(
  raw: string,
  schema: TSchema,
  key: string,
  field?: string,
): z.output<TSchema> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new RedisJsonError(key, field, error);
  }
  const result = schema.safeParse(value);
  if (!result.success) throw new RedisJsonError(key, field, result.error);
  return result.data;
}

// Values are validated before writing too, so a bug can't plant data every reader rejects.
// Schemas used here must round-trip (no transforms), since the parsed value is what's stored.
function serialize<TSchema extends z.ZodType>(schema: TSchema, value: z.input<TSchema>): string {
  return JSON.stringify(schema.parse(value));
}

export async function getJson<TSchema extends z.ZodType>(
  redis: Redis,
  key: string,
  schema: TSchema,
): Promise<z.output<TSchema> | null> {
  const raw = await redis.get(key);
  return raw === null ? null : parseRedisJson(raw, schema, key);
}

export async function setJson<TSchema extends z.ZodType>(
  redis: Redis,
  key: string,
  schema: TSchema,
  value: z.input<TSchema>,
  options: { ttlSeconds?: number } = {},
): Promise<void> {
  const payload = serialize(schema, value);
  if (options.ttlSeconds === undefined) await redis.set(key, payload);
  else await redis.set(key, payload, 'EX', options.ttlSeconds);
}

export async function hgetJson<TSchema extends z.ZodType>(
  redis: Redis,
  key: string,
  field: string,
  schema: TSchema,
): Promise<z.output<TSchema> | null> {
  const raw = await redis.hget(key, field);
  return raw === null ? null : parseRedisJson(raw, schema, key, field);
}

export async function hsetJson<TSchema extends z.ZodType>(
  redis: Redis,
  key: string,
  field: string,
  schema: TSchema,
  value: z.input<TSchema>,
): Promise<void> {
  await redis.hset(key, field, serialize(schema, value));
}

export async function hgetallJson<TSchema extends z.ZodType>(
  redis: Redis,
  key: string,
  schema: TSchema,
): Promise<Map<string, z.output<TSchema>>> {
  const entries = await redis.hgetall(key);
  const result = new Map<string, z.output<TSchema>>();
  for (const [field, raw] of Object.entries(entries)) {
    result.set(field, parseRedisJson(raw, schema, key, field));
  }
  return result;
}

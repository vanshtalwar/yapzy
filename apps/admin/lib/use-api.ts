'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { type z } from 'zod';

import { api, ApiError } from './api.ts';

/** GET + Zod-validated JSON with optional polling; `path = null` skips the request. */
export function useApi<T extends z.ZodType>(
  path: string | null,
  schema: T,
  options: { refreshMs?: number } = {},
) {
  const [data, setData] = useState<z.output<T> | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const schemaRef = useRef(schema);

  const load = useCallback(async () => {
    if (path === null) return;
    try {
      setData(await api.get(path, schemaRef.current));
      setError(null);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause : new ApiError(0, 'INTERNAL_ERROR', 'Failed'));
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    void load();
    if (options.refreshMs === undefined) return;
    const timer = setInterval(() => void load(), options.refreshMs);
    return () => {
      clearInterval(timer);
    };
  }, [load, options.refreshMs]);

  return { data, error, loading, reload: load };
}

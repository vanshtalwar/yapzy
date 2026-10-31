'use client';

import { useCallback, useEffect, useState } from 'react';
import { type z } from 'zod';

import { api } from '../lib/api.ts';

/** Cursor-paginated GET (`{ items, nextCursor }`) with "load more". */
export function usePaged<T extends z.ZodType<{ items: unknown[]; nextCursor: string | null }>>(
  base: string,
  schema: T,
) {
  type Item = z.output<T>['items'][number];
  const [items, setItems] = useState<Item[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let active = true;
    api.get(base, schema).then(
      (page) => {
        if (!active) return;
        setItems(page.items);
        setCursor(page.nextCursor);
        setLoading(false);
      },
      () => {
        if (active) setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [base, schema, version]);

  const more = useCallback(async () => {
    if (cursor === null) return;
    const page = await api.get(`${base}${base.includes('?') ? '&' : '?'}cursor=${cursor}`, schema);
    setItems((current) => [...current, ...(page.items as Item[])]);
    setCursor(page.nextCursor);
  }, [base, cursor, schema]);

  return {
    items,
    loading,
    hasMore: cursor !== null,
    more,
    reload: () => {
      setVersion((v) => v + 1);
    },
  };
}

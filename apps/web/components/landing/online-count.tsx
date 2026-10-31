'use client';

import { Badge, StatusDot } from '@app/ui';
import { useEffect, useState } from 'react';

import { api } from '../../lib/api.ts';

const POLL_MS = 10_000;

/** Live "N online" badge, polled every 10 s (the API caches it for 2 s). */
export function OnlineCount() {
  const [online, setOnline] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const count = await api.getOnlineCount();
        if (active) setOnline(count);
      } catch {
        if (active) setOnline(null);
      }
    };
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  return (
    <Badge variant="outline" className="gap-2 py-1">
      <StatusDot tone={online === null ? 'offline' : 'online'} pulse={online !== null} />
      <span aria-live="polite">
        {online === null ? 'Connecting…' : `${online.toLocaleString()} online`}
      </span>
    </Badge>
  );
}

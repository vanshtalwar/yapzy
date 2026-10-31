'use client';

import { useEffect, useRef } from 'react';

interface TurnstileOptions {
  sitekey: string;
  theme: 'auto' | 'light' | 'dark';
  callback: (token: string) => void;
  'expired-callback': () => void;
  'error-callback': () => void;
}

interface TurnstileApi {
  render(container: HTMLElement, options: TurnstileOptions): string;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let loader: Promise<TurnstileApi> | null = null;

/** Loads Cloudflare's script once per page (the only third-party script the app allows). */
function loadTurnstile(): Promise<TurnstileApi> {
  loader ??= new Promise<TurnstileApi>((resolve, reject) => {
    if (window.turnstile !== undefined) {
      resolve(window.turnstile);
      return;
    }
    const script = document.createElement('script');
    script.src = SCRIPT_URL;
    script.async = true;
    script.onload = () => {
      if (window.turnstile === undefined) reject(new Error('Turnstile unavailable'));
      else resolve(window.turnstile);
    };
    script.onerror = () => {
      loader = null; // allow a retry
      reject(new Error('Could not load the bot check'));
    };
    document.head.appendChild(script);
  });
  return loader;
}

export interface TurnstileProps {
  siteKey: string;
  onToken: (token: string) => void;
  onExpire: () => void;
  onError: () => void;
}

/** Cloudflare Turnstile widget. Remount it (change `key`) to get a fresh single-use token. */
export function Turnstile({ siteKey, onToken, onExpire, onError }: TurnstileProps) {
  const container = useRef<HTMLDivElement>(null);
  const handlers = useRef({ onToken, onExpire, onError });

  useEffect(() => {
    handlers.current = { onToken, onExpire, onError };
  }, [onToken, onExpire, onError]);

  useEffect(() => {
    let widgetId: string | null = null;
    let cancelled = false;
    loadTurnstile().then(
      (turnstile) => {
        if (cancelled || container.current === null) return;
        widgetId = turnstile.render(container.current, {
          sitekey: siteKey,
          theme: 'auto',
          callback: (token) => {
            handlers.current.onToken(token);
          },
          'expired-callback': () => {
            handlers.current.onExpire();
          },
          'error-callback': () => {
            handlers.current.onError();
          },
        });
      },
      () => {
        if (!cancelled) handlers.current.onError();
      },
    );
    return () => {
      cancelled = true;
      if (widgetId !== null) window.turnstile?.remove(widgetId);
    };
  }, [siteKey]);

  return <div ref={container} className="min-h-[65px]" />;
}

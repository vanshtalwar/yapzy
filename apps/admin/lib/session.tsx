'use client';

import { type AdminMe, adminMeSchema, okSchema } from '@app/shared';
import { useRouter } from 'next/navigation';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react';

import { api, setCsrfToken, setUnauthorizedHandler } from './api.ts';

interface SessionValue {
  me: AdminMe | null;
  loading: boolean;
  signedIn: (me: AdminMe) => void;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

/** The signed-in admin (from `GET /auth/me`) and the CSRF token for mutations. */
export function SessionProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [me, setMe] = useState<AdminMe | null>(null);
  const [loading, setLoading] = useState(true);

  const signedIn = useCallback((value: AdminMe) => {
    setCsrfToken(value.csrfToken);
    setMe(value);
  }, []);

  const refresh = useCallback(async () => {
    try {
      signedIn(await api.get('/auth/me', adminMeSchema));
    } catch {
      setCsrfToken(null);
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, [signedIn]);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setCsrfToken(null);
      setMe(null);
      router.replace('/login');
    });
    let active = true;
    api
      .get('/auth/me', adminMeSchema)
      .then(
        (value) => {
          if (active) signedIn(value);
        },
        () => {
          setCsrfToken(null);
        },
      )
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      setUnauthorizedHandler(null);
    };
  }, [router, signedIn]);

  const logout = useCallback(async () => {
    await api.post('/auth/logout', okSchema).catch(() => undefined);
    setCsrfToken(null);
    setMe(null);
    router.replace('/login');
  }, [router]);

  return (
    <SessionContext.Provider value={{ me, loading, signedIn, refresh, logout }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (value === null) throw new Error('useSession() outside <SessionProvider>');
  return value;
}

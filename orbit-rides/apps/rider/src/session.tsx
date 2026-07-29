/**
 * Sesión y cliente del API, en un contexto.
 *
 * El cliente se crea UNA vez: si se recreara en cada render, cada request
 * abriría una conexión nueva y el WebSocket se reconectaría sin parar.
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AsyncTokenStorage, OrbitClient, humanMessage, type Me } from '@orbit/client';
import { config } from './config';

interface SessionValue {
  readonly client: OrbitClient;
  readonly me: Me | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly login: (phone: string) => Promise<void>;
  readonly logout: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // useMemo con dependencias vacías: una sola instancia para toda la vida de la
  // app. `onUnauthenticated` limpia el estado para que la UI vuelva al login sin
  // que cada pantalla tenga que chequear el 401 por su cuenta.
  const client = useMemo(
    () =>
      new OrbitClient({
        baseUrl: config.apiUrl,
        storage: new AsyncTokenStorage(AsyncStorage),
        onUnauthenticated: () => setMe(null),
      }),
    [],
  );

  /** Al arrancar: si hay token guardado, se valida contra /v1/me. */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        if (await client.hasSession()) {
          const profile = await client.me();
          if (!cancelled) setMe(profile);
        }
      } catch {
        // Token viejo o inválido: se descarta en silencio y se muestra el login.
        await client.logout();
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  const login = useCallback(
    async (phone: string) => {
      setError(null);
      setLoading(true);
      try {
        await client.devLogin(phone);
        setMe(await client.me());
      } catch (err) {
        setError(humanMessage(err));
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [client],
  );

  const logout = useCallback(async () => {
    await client.logout();
    setMe(null);
  }, [client]);

  const value = useMemo(
    () => ({ client, me, loading, error, login, logout }),
    [client, me, loading, error, login, logout],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession se usó fuera de SessionProvider');
  return value;
}

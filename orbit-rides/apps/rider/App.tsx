/**
 * Orbit Rides — app de pasajero.
 *
 * Navegación con un reducer en vez de react-navigation. El flujo es lineal
 * (login → mapa → precio → viaje → cierre) y una dependencia menos es un
 * problema menos: react-navigation trae gestos, contexto y configuración nativa
 * que acá no hacen falta.
 */

import React, { useEffect, useState } from 'react';
import { ActivityIndicator, SafeAreaView, StatusBar, StyleSheet, Text, View } from 'react-native';
import type { Settlement, Trip } from '@orbit/client';
import { SessionProvider, useSession } from './src/session';
import { LoginScreen } from './src/screens/Login';
import { HomeScreen, type HomeResult } from './src/screens/Home';
import { QuoteScreen } from './src/screens/Quote';
import { TrackingScreen } from './src/screens/Tracking';
import { DoneScreen } from './src/screens/Done';
import { colors, space } from './src/theme';

type Screen =
  | { readonly name: 'home' }
  | { readonly name: 'quote'; readonly request: HomeResult }
  | { readonly name: 'tracking'; readonly tripId: string }
  | { readonly name: 'done'; readonly trip: Trip; readonly settlement: Settlement | null };

function Flow(): React.ReactElement {
  const { me, loading, client } = useSession();
  const [screen, setScreen] = useState<Screen>({ name: 'home' });
  const [restoring, setRestoring] = useState(true);

  /**
   * Al entrar, si hay un viaje abierto se vuelve a su pantalla.
   *
   * Sin esto, un pasajero que cierra la app a mitad de viaje la reabre en el
   * mapa vacío, sin forma de volver a ver dónde está su conductor.
   */
  useEffect(() => {
    if (!me) {
      setRestoring(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const active = await client.activeTrip();
        if (!cancelled && active) setScreen({ name: 'tracking', tripId: active.id });
      } catch {
        // Si falla, se arranca en el mapa. No vale la pena bloquear por esto.
      } finally {
        if (!cancelled) setRestoring(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [me, client]);

  if (loading || (me && restoring)) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.brand2} size="large" />
        <Text style={styles.loadingText}>Orbit Rides</Text>
      </View>
    );
  }

  if (!me) return <LoginScreen />;

  switch (screen.name) {
    case 'home':
      return <HomeScreen onQuote={(request) => setScreen({ name: 'quote', request })} />;

    case 'quote':
      return (
        <QuoteScreen
          request={screen.request}
          onRequested={(tripId) => setScreen({ name: 'tracking', tripId })}
          onBack={() => setScreen({ name: 'home' })}
        />
      );

    case 'tracking':
      return (
        <TrackingScreen
          tripId={screen.tripId}
          onFinished={(trip, settlement) => setScreen({ name: 'done', trip, settlement })}
        />
      );

    case 'done':
      return (
        <DoneScreen
          trip={screen.trip}
          settlement={screen.settlement}
          onRestart={() => setScreen({ name: 'home' })}
        />
      );
  }
}

export default function App(): React.ReactElement {
  return (
    <SessionProvider>
      <SafeAreaView style={styles.root}>
        <StatusBar barStyle="light-content" backgroundColor={colors.bg} />
        <Flow />
      </SafeAreaView>
    </SessionProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.lg },
  loadingText: { color: colors.dim, fontSize: 14, letterSpacing: 1 },
});

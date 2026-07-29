/**
 * Orbit Conductor.
 *
 * Binario aparte de la app de pasajero a propósito: la de conductor necesita
 * ubicación continua, pantalla encendida y —cuando se implemente— foreground
 * service. Meter los dos roles en un mismo proceso obliga a pedirle permisos de
 * ubicación permanente a un pasajero que no los necesita, y complica el ciclo de
 * vida de los dos.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, SafeAreaView, StatusBar, StyleSheet, Text, View } from 'react-native';
import type { DriverOffer, Settlement } from '@orbit/client';
import { SessionProvider, useSession } from './src/session';
import { LoginScreen } from './src/screens/Login';
import { OnlineScreen } from './src/screens/Online';
import { OfferScreen } from './src/screens/Offer';
import { ActiveTripScreen } from './src/screens/ActiveTrip';
import { Button, Card, Row } from './src/components/ui';
import { colors, money, space } from './src/theme';

type Screen =
  | { readonly name: 'online' }
  | { readonly name: 'offer'; readonly offer: DriverOffer }
  | { readonly name: 'trip'; readonly tripId: string }
  | { readonly name: 'settled'; readonly settlement: Settlement | null };

function Flow(): React.ReactElement {
  const { me, loading, client } = useSession();
  const [screen, setScreen] = useState<Screen>({ name: 'online' });
  const [restoring, setRestoring] = useState(true);

  /**
   * Al entrar, si hay un viaje activo se vuelve a su pantalla.
   *
   * Para un conductor esto es más crítico que para el pasajero: si la app se
   * cierra a mitad de viaje y vuelve al mapa vacío, no tiene forma de marcar
   * "llegué" ni de cerrar el viaje, y el viaje queda colgado.
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
        if (!cancelled && active) setScreen({ name: 'trip', tripId: active.id });
      } catch {
        // Si falla, arranca en el mapa.
      } finally {
        if (!cancelled) setRestoring(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [me, client]);

  // useCallback estable: OnlineScreen lo usa como dependencia de sus effects, y
  // una función nueva en cada render reabriría el WebSocket sin parar.
  const handleOffer = useCallback((offer: DriverOffer) => {
    setScreen((current) => (current.name === 'online' ? { name: 'offer', offer } : current));
  }, []);

  if (loading || (me && restoring)) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.warn} size="large" />
        <Text style={styles.loadingText}>Orbit Conductor</Text>
      </View>
    );
  }

  if (!me) return <LoginScreen />;

  switch (screen.name) {
    case 'online':
      return <OnlineScreen onOffer={handleOffer} />;

    case 'offer':
      return (
        <OfferScreen
          offer={screen.offer}
          onAccepted={(tripId) => setScreen({ name: 'trip', tripId })}
          onDismiss={() => setScreen({ name: 'online' })}
        />
      );

    case 'trip':
      return (
        <ActiveTripScreen
          tripId={screen.tripId}
          onFinished={(settlement) => setScreen({ name: 'settled', settlement })}
        />
      );

    case 'settled':
      return (
        <View style={styles.settled}>
          <Text style={styles.settledTitle}>Viaje cerrado</Text>
          {screen.settlement ? (
            <Card>
              <Row label="Tarifa" value={money(screen.settlement.fareCents, screen.settlement.currency)} />
              <Row label="Comisión" value={money(screen.settlement.commissionCents, screen.settlement.currency)} />
              <Row
                label="Para vos"
                value={money(screen.settlement.driverEarningsCents, screen.settlement.currency)}
                strong
              />
              {screen.settlement.recalculated && (
                <Text style={styles.note}>
                  El servidor ajustó la tarifa con el recorrido real, con tope sobre lo cotizado.
                </Text>
              )}
            </Card>
          ) : (
            <Text style={styles.note}>Sin datos de liquidación.</Text>
          )}
          <Button label="Volver a recibir viajes" onPress={() => setScreen({ name: 'online' })} />
        </View>
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
  settled: { flex: 1, justifyContent: 'center', padding: space.xl, gap: space.lg },
  settledTitle: { color: colors.ink, fontSize: 26, fontWeight: '800', letterSpacing: -0.6 },
  note: { color: colors.dim2, fontSize: 11, lineHeight: 16, marginTop: space.sm },
});

import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { Settlement, Trip } from '@orbit/client';
import { Button, Card, Row } from '../components/ui';
import { colors, money, space } from '../theme';

/** Cierre del viaje: recibo o explicación de por qué no salió. */
export function DoneScreen({
  trip, settlement, onRestart,
}: {
  trip: Trip;
  settlement: Settlement | null;
  onRestart: () => void;
}): React.ReactElement {
  const completed = trip.status === 'COMPLETED';
  const fare = settlement?.fareCents ?? trip.fareCents;

  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      <Text style={styles.title}>
        {completed ? 'Llegaste' : trip.status === 'NO_DRIVERS' ? 'Sin conductores' : 'Viaje cancelado'}
      </Text>

      {completed && fare !== null ? (
        <Card>
          <Row label="Tarifa" value={money(fare, trip.currency)} />
          {settlement?.recalculated && (
            <Text style={styles.note}>
              El servidor recalculó la tarifa con el recorrido real. El ajuste tiene tope.
            </Text>
          )}
          <Row
            label="Pago"
            value={trip.paymentMethod === 'cash' ? 'Efectivo' : trip.paymentMethod === 'card' ? 'Tarjeta' : 'Wallet'}
          />
          <Row label="Total" value={money(fare, trip.currency)} strong />
        </Card>
      ) : (
        <Card>
          <Text style={styles.detail}>
            {trip.status === 'NO_DRIVERS'
              ? 'No había conductores disponibles cerca. Suele resolverse en unos minutos.'
              : trip.cancellationFeeCents > 0
                ? `Se aplicó un cargo por cancelación de ${money(trip.cancellationFeeCents, trip.currency)}.`
                : 'No hubo cargo por esta cancelación.'}
          </Text>
        </Card>
      )}

      <View style={styles.timeline}>
        <Text style={styles.timelineTitle}>Historia del viaje</Text>
        {trip.events.map((event, index) => (
          <View key={`${event.to}-${index}`} style={styles.event}>
            <Text style={styles.eventStatus}>{event.to}</Text>
            <Text style={styles.eventActor}>{event.actor}</Text>
          </View>
        ))}
        <Text style={styles.note}>
          Cada transición queda registrada del lado del servidor y no se puede editar.
        </Text>
      </View>

      <Button label="Pedir otro viaje" onPress={onRestart} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { flexGrow: 1, justifyContent: 'center', padding: space.xl, gap: space.lg },
  title: { color: colors.ink, fontSize: 26, fontWeight: '800', letterSpacing: -0.6 },
  detail: { color: colors.dim, fontSize: 13.5, lineHeight: 20 },
  note: { color: colors.dim2, fontSize: 11, lineHeight: 16, marginTop: space.sm },
  timeline: { gap: space.xs },
  timelineTitle: { color: colors.ink, fontSize: 14, fontWeight: '700', marginBottom: space.xs },
  event: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 },
  eventStatus: { color: colors.dim, fontSize: 11.5, fontFamily: 'monospace' },
  eventActor: { color: colors.dim2, fontSize: 11 },
});

import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { ConflictError, ForbiddenError, humanMessage, type DriverOffer, type Trip } from '@orbit/client';
import { Banner, Button, Card, Row } from '../components/ui';
import { colors, money, space } from '../theme';
import { useSession } from '../session';

/**
 * Oferta de viaje con cuenta atrás.
 *
 * La oferta es EXCLUSIVA: mientras esté vigente, ningún otro conductor la tiene.
 * Eso es lo que hace que el conductor pueda mirar la pantalla 15 segundos sin
 * competir con nadie, en vez de pelear por apretar primero manejando.
 *
 * Si vence, la pantalla se cierra sola: dejar un botón muerto en pantalla hace
 * que el conductor lo apriete y reciba un error que no entiende.
 */
export function OfferScreen({
  offer, onAccepted, onDismiss,
}: {
  offer: DriverOffer;
  onAccepted: (tripId: string) => void;
  onDismiss: () => void;
}): React.ReactElement {
  const { client } = useSession();
  const [trip, setTrip] = useState<Trip | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(15);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const detail = await client.getTrip(offer.tripId);
        if (!cancelled) setTrip(detail);
      } catch (err) {
        if (!cancelled) setError(humanMessage(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, offer.tripId]);

  useEffect(() => {
    const expiry = new Date(offer.expiresAt).getTime();
    const tick = (): void => {
      const left = Math.max(0, Math.round((expiry - Date.now()) / 1000));
      setSecondsLeft(left);
      if (left === 0) onDismiss();
    };
    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [offer.expiresAt, onDismiss]);

  const accept = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await client.acceptTrip(offer.tripId);
      onAccepted(result.tripId);
    } catch (err) {
      // Estos dos casos no son fallos: son la carrera normal del dispatch, y
      // merecen un mensaje que el conductor entienda en vez de "error 409".
      if (err instanceof ConflictError || err instanceof ForbiddenError) {
        setError('Otro conductor tomó este viaje.');
        setTimeout(onDismiss, 1600);
      } else {
        setError(humanMessage(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const reject = async (): Promise<void> => {
    setBusy(true);
    try {
      await client.rejectOffer(offer.tripId);
    } catch {
      // Rechazar es best-effort: si falla, la oferta vence sola igual.
    } finally {
      onDismiss();
    }
  };

  return (
    <View style={styles.wrap}>
      <View style={styles.timerBox}>
        <Text style={styles.timer}>{secondsLeft}</Text>
        <Text style={styles.timerLabel}>segundos para decidir</Text>
        <View style={styles.bar}>
          <View style={[styles.barFill, { width: `${(secondsLeft / 15) * 100}%` }]} />
        </View>
      </View>

      {error && <Banner text={error} tone="bad" />}

      <Card>
        <Text style={styles.label}>VIAJE NUEVO</Text>
        {trip ? (
          <>
            <Text style={styles.address} numberOfLines={2}>
              {trip.origin.address ?? 'Punto de encuentro'}
            </Text>
            <Text style={styles.arrow}>↓</Text>
            <Text style={styles.address} numberOfLines={2}>
              {trip.destination.address ?? 'Destino'}
            </Text>

            <View style={styles.divider} />
            <Row
              label="Pago"
              value={trip.paymentMethod === 'cash' ? 'Efectivo' : trip.paymentMethod === 'card' ? 'Tarjeta' : 'Wallet'}
            />
            {trip.fareCents !== null && <Row label="Tarifa" value={money(trip.fareCents, trip.currency)} strong />}
            {trip.paymentMethod === 'cash' && (
              <Text style={styles.note}>
                Cobrás la tarifa completa en la mano. La comisión queda a cobrar y se
                descuenta del próximo pago.
              </Text>
            )}
          </>
        ) : (
          <Text style={styles.note}>Cargando el viaje…</Text>
        )}
      </Card>

      <Button
        label="Aceptar"
        onPress={() => void accept()}
        loading={busy}
        disabled={secondsLeft === 0 || !trip}
      />
      <Button label="Rechazar" variant="ghost" onPress={() => void reject()} disabled={busy} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.bg, padding: space.xl, justifyContent: 'center', gap: space.md },
  timerBox: { alignItems: 'center', gap: space.xs, marginBottom: space.md },
  timer: { color: colors.warn, fontSize: 56, fontWeight: '800', letterSpacing: -2 },
  timerLabel: { color: colors.dim, fontSize: 12 },
  bar: { height: 5, backgroundColor: colors.line, borderRadius: 3, width: '100%', overflow: 'hidden', marginTop: space.sm },
  barFill: { height: '100%', backgroundColor: colors.warn },
  label: { color: colors.dim2, fontSize: 10, fontWeight: '700', letterSpacing: 0.8, marginBottom: space.sm },
  address: { color: colors.ink, fontSize: 15, fontWeight: '600', lineHeight: 21 },
  arrow: { color: colors.dim2, fontSize: 16, marginVertical: space.xs },
  divider: { height: 1, backgroundColor: colors.line, marginVertical: space.md },
  note: { color: colors.dim2, fontSize: 11, lineHeight: 16, marginTop: space.sm },
});

import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  decodePolyline, humanMessage, type LatLng, type PaymentMethod, type Quote,
} from '@orbit/client';
import { OrbitMap } from '../components/OrbitMap';
import { Banner, Button, Card, Row } from '../components/ui';
import { colors, km, minutes, money, radius, space } from '../theme';
import { useSession } from '../session';
import type { HomeResult } from './Home';

const METHODS: ReadonlyArray<{ value: PaymentMethod; label: string }> = [
  { value: 'cash', label: 'Efectivo' },
  { value: 'card', label: 'Tarjeta' },
  { value: 'wallet', label: 'Wallet' },
];

/**
 * Cotización y confirmación.
 *
 * El monto lo calcula y lo firma el servidor. La app manda el `quoteId`, nunca
 * un precio: si mandara un precio, el precio sería editable.
 */
export function QuoteScreen({
  request, onRequested, onBack,
}: {
  request: HomeResult;
  onRequested: (tripId: string) => void;
  onBack: () => void;
}): React.ReactElement {
  const { client } = useSession();
  const [quote, setQuote] = useState<Quote | null>(null);
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [error, setError] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await client.createQuote({
          origin: request.origin,
          originAddress: request.originAddress,
          destination: request.destination,
          destinationAddress: request.destinationAddress,
        });
        if (!cancelled) setQuote(result);
      } catch (err) {
        if (!cancelled) setError(humanMessage(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, request]);

  /**
   * Cuenta atrás de la cotización.
   *
   * El servidor la vence a los 120 s. Sin mostrarlo, el usuario pide el viaje,
   * recibe un error incomprensible y no entiende que solo tenía que pedir una
   * nueva.
   */
  useEffect(() => {
    if (!quote) return;
    const expiry = new Date(quote.expiresAt).getTime();
    const tick = (): void => setSecondsLeft(Math.max(0, Math.round((expiry - Date.now()) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [quote]);

  const request_ = async (): Promise<void> => {
    if (!quote) return;
    setRequesting(true);
    setError(null);
    try {
      const trip = await client.requestTrip(quote.quoteId, method);
      onRequested(trip.tripId);
    } catch (err) {
      setError(humanMessage(err));
    } finally {
      setRequesting(false);
    }
  };

  const expired = quote !== null && secondsLeft <= 0;

  /**
   * Recorrido real de la cotización.
   *
   * Mientras la cotización no llegó, o si vino de la estimación local, se
   * dibuja la recta. No es cosmético: la tarifa se calcula sobre la distancia
   * por calle, así que una recta junto a un precio de ruta real le muestra al
   * pasajero un trayecto más corto que el que está pagando.
   */
  const routeLine: readonly LatLng[] = useMemo(() => {
    const decoded = decodePolyline(quote?.routePolyline);
    return decoded.length >= 2 ? decoded : [request.origin, request.destination];
  }, [quote?.routePolyline, request.origin, request.destination]);

  return (
    <View style={styles.wrap}>
      <View style={styles.mapArea}>
        <OrbitMap
          center={request.origin}
          markers={[
            { id: 'o', position: request.origin, kind: 'origin' },
            { id: 'd', position: request.destination, kind: 'destination' },
          ]}
          route={routeLine}
        />
      </View>

      <View style={styles.sheet}>
        <View style={styles.grip} />
        <Text style={styles.title} numberOfLines={1}>{request.destinationAddress}</Text>

        {error && <Banner text={error} tone="bad" />}

        {!quote ? (
          <Text style={styles.loading}>Calculando el precio…</Text>
        ) : (
          <>
            <Card>
              <View style={styles.priceRow}>
                <Text style={styles.price}>{money(quote.fareCents, quote.currency)}</Text>
                <View style={styles.etaBox}>
                  <Text style={styles.eta}>{minutes(quote.durationSeconds)}</Text>
                  <Text style={styles.etaLabel}>{km(quote.distanceMeters)}</Text>
                </View>
              </View>

              <View style={styles.divider} />
              <Row label="Tarifa base" value={money(quote.breakdown.baseCents, '')} />
              <Row label="Distancia" value={money(quote.breakdown.distanceCents, '')} />
              <Row label="Tiempo" value={money(quote.breakdown.timeCents, '')} />
              {quote.breakdown.serviceFeeCents > 0 && (
                <Row label="Servicio" value={money(quote.breakdown.serviceFeeCents, '')} />
              )}
              <Row label="Total" value={money(quote.fareCents, quote.currency)} strong />

              <Text style={styles.signed}>
                Precio firmado por el servidor
                {expired ? ' · VENCIDO' : ` · vence en ${secondsLeft} s`}
              </Text>
              {quote.routeProvider === 'estimate' && (
                <Text style={styles.estimate}>
                  Ruta estimada: el servicio de mapas no respondió. El precio es válido.
                </Text>
              )}
            </Card>

            <View style={styles.methods}>
              {METHODS.map((option) => (
                <Pressable
                  key={option.value}
                  onPress={() => setMethod(option.value)}
                  style={[styles.method, method === option.value && styles.methodOn]}
                >
                  <Text style={[styles.methodText, method === option.value && styles.methodTextOn]}>
                    {option.label}
                  </Text>
                </Pressable>
              ))}
            </View>

            <Button
              label={expired ? 'El precio venció' : `Pedir Orbit · ${money(quote.fareCents, '')}`}
              onPress={() => void request_()}
              loading={requesting}
              disabled={expired}
            />
          </>
        )}

        <Button label="Cambiar destino" variant="ghost" onPress={onBack} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.bg },
  mapArea: { flex: 1 },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl,
    borderTopWidth: 1, borderColor: colors.line,
    padding: space.lg, paddingBottom: space.xl, gap: space.sm,
  },
  grip: { width: 38, height: 4, borderRadius: 2, backgroundColor: colors.line, alignSelf: 'center', marginBottom: space.sm },
  title: { color: colors.ink, fontSize: 16, fontWeight: '700' },
  loading: { color: colors.dim, fontSize: 14, paddingVertical: space.xl, textAlign: 'center' },
  priceRow: { flexDirection: 'row', alignItems: 'flex-end', marginBottom: space.md },
  price: { color: colors.ink, fontSize: 30, fontWeight: '800', letterSpacing: -1, flex: 1 },
  etaBox: { alignItems: 'flex-end' },
  eta: { color: colors.ink, fontSize: 17, fontWeight: '800' },
  etaLabel: { color: colors.dim2, fontSize: 10.5, letterSpacing: 0.5 },
  divider: { height: 1, backgroundColor: colors.line, marginBottom: space.md },
  signed: { color: colors.ok, fontSize: 10.5, marginTop: space.sm },
  estimate: { color: colors.warn, fontSize: 10.5, marginTop: space.xs, lineHeight: 15 },
  methods: { flexDirection: 'row', gap: space.sm },
  method: {
    flex: 1, alignItems: 'center', paddingVertical: space.md,
    backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md,
  },
  methodOn: { borderColor: colors.brand, backgroundColor: 'rgba(108,92,255,0.15)' },
  methodText: { color: colors.dim, fontSize: 12.5, fontWeight: '700' },
  methodTextOn: { color: colors.ink },
});

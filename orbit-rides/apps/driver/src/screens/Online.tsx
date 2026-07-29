import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Switch, Text, View } from 'react-native';
import * as Location from 'expo-location';
import {
  TripSocket, humanMessage,
  type DriverOffer, type Earnings, type LatLng, type SocketMessage, type SocketState,
} from '@orbit/client';
import { OrbitMap } from '../components/OrbitMap';
import { Banner, Button, Card, Row } from '../components/ui';
import { colors, money, radius, space } from '../theme';
import { MONTEVIDEO, POSITION_INTERVAL_MS } from '../config';
import { useSession } from '../session';

/**
 * Pantalla principal del conductor: online/offline, posición y espera de ofertas.
 *
 * LÍMITE CONOCIDO Y ASUMIDO: la ubicación es de primer plano. Si el conductor
 * minimiza la app, deja de reportar y a los 30 segundos desaparece del índice de
 * Redis y no recibe más viajes.
 *
 * Arreglarlo requiere ubicación en background con foreground service, que en
 * Android es la parte más peleada del desarrollo —cada fabricante mata procesos
 * distinto, Xiaomi y Huawei son los peores— y merece su propia iteración con
 * pruebas en dispositivos reales. Se documenta acá en vez de fingir que funciona.
 */
export function OnlineScreen({ onOffer }: { onOffer: (offer: DriverOffer) => void }): React.ReactElement {
  const { client, me, logout } = useSession();
  const [online, setOnline] = useState(false);
  const [position, setPosition] = useState<LatLng>(MONTEVIDEO);
  const [earnings, setEarnings] = useState<Earnings | null>(null);
  const [connection, setConnection] = useState<SocketState>('closed');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const watcher = useRef<Location.LocationSubscription | null>(null);

  const loadEarnings = useCallback(async () => {
    try {
      setEarnings(await client.earnings());
    } catch {
      // Las ganancias son informativas: si fallan, no vale la pena molestar.
    }
  }, [client]);

  useEffect(() => {
    void loadEarnings();
  }, [loadEarnings]);

  /**
   * Reporta la posición mientras está online.
   *
   * DOS mecanismos, y hacen falta los dos:
   *
   *  1. `watchPositionAsync` avisa cuando el conductor SE MUEVE. Da precisión y
   *     rumbo actualizados sin gastar batería mientras está quieto.
   *
   *  2. Un LATIDO en intervalo fijo que reenvía la última posición conocida,
   *     se haya movido o no.
   *
   * El segundo es el que importa y es el que me faltaba. El backend expira la
   * posición en Redis a los 30 segundos: si no llega nada, el conductor se cae
   * del índice y deja de recibir ofertas. Con solo el watcher, un conductor
   * parado en un semáforo o esperando en una esquina desaparece del dispatch a
   * los treinta segundos — justo cuando está MÁS disponible.
   *
   * El síntoma en desarrollo fue peor de diagnosticar: el emulador está quieto,
   * así que el watcher disparaba una vez y nunca más, y todos los viajes daban
   * NO_DRIVERS aunque la base mostrara al conductor en Montevideo y online.
   */
  useEffect(() => {
    if (!online) return;
    let cancelled = false;
    // La última posición conocida vive en un ref: el latido tiene que poder
    // leerla sin que el intervalo se recree en cada actualización del GPS.
    let lastKnown: { coords: LatLng; heading: number | null } | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;

    const report = async (coords: LatLng, heading: number | null): Promise<void> => {
      try {
        await client.setPosition({ position: coords, bearing: heading, isOnline: true });
        if (!cancelled) setError(null);
      } catch (err) {
        if (!cancelled) setError(humanMessage(err));
      }
    };

    void (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        if (!cancelled) {
          setError('Sin permiso de ubicación no podés recibir viajes.');
          setOnline(false);
        }
        return;
      }

      // Posición inicial: sin esto, el conductor no aparece en el índice hasta
      // que se mueva por primera vez.
      try {
        const first = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
        if (cancelled) return;
        const coords = { lat: first.coords.latitude, lng: first.coords.longitude };
        lastKnown = { coords, heading: first.coords.heading ?? null };
        setPosition(coords);
        await report(coords, lastKnown.heading);
      } catch (err) {
        if (!cancelled) setError(humanMessage(err));
      }

      if (cancelled) return;

      watcher.current = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.High, timeInterval: POSITION_INTERVAL_MS, distanceInterval: 25 },
        (update) => {
          if (cancelled) return;
          const coords = { lat: update.coords.latitude, lng: update.coords.longitude };
          lastKnown = { coords, heading: update.coords.heading ?? null };
          setPosition(coords);
          void report(coords, lastKnown.heading);
        },
      );

      // El latido. Reenvía lo último conocido aunque el conductor no se mueva.
      heartbeat = setInterval(() => {
        if (cancelled || !lastKnown) return;
        void report(lastKnown.coords, lastKnown.heading);
      }, POSITION_INTERVAL_MS);
    })();

    return () => {
      cancelled = true;
      watcher.current?.remove();
      watcher.current = null;
      if (heartbeat) clearInterval(heartbeat);
    };
  }, [online, client]);

  /** WebSocket del canal del conductor: por acá llegan las ofertas. */
  useEffect(() => {
    if (!online) return;
    const socket = new TripSocket({
      getUrl: () => client.socketUrl(),
      onStateChange: setConnection,
      onMessage: (message: SocketMessage) => {
        if (message.type === 'trip.offer') {
          onOffer({ tripId: message.data.tripId, expiresAt: message.data.expiresAt });
        }
      },
      onError: () => {
        // Reconecta solo; el polling de abajo cubre el hueco.
      },
    });
    void socket.connect();
    return () => socket.close();
  }, [online, client, onOffer]);

  /**
   * Respaldo por polling.
   *
   * Si el WebSocket estaba caído justo cuando el dispatch ofertó, el conductor
   * perdería el viaje sin enterarse. La oferta dura 15 segundos, así que
   * consultar cada 4 deja margen para verla.
   */
  useEffect(() => {
    if (!online) return;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const offer = await client.currentOffer();
          if (offer) onOffer(offer);
        } catch {
          // Silencio: el WebSocket es el camino principal.
        }
      })();
    }, 4000);
    return () => clearInterval(timer);
  }, [online, client, onOffer]);

  const toggle = async (next: boolean): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      if (!next) {
        await client.setPosition({ position, bearing: null, isOnline: false });
      }
      setOnline(next);
    } catch (err) {
      setError(humanMessage(err));
    } finally {
      setBusy(false);
    }
  };

  /**
   * ¿Está dentro del área operativa?
   *
   * Es una caja aproximada alrededor de Montevideo, solo para avisar en la UI.
   * La verdad la tiene el servidor, que valida contra el polígono real de la
   * ciudad con PostGIS.
   */
  const inMontevideo =
    position.lat > -35.0 && position.lat < -34.7 &&
    position.lng > -56.5 && position.lng < -55.9;

  return (
    <View style={styles.wrap}>
      <View style={styles.mapArea}>
        <OrbitMap center={position} zoom={14} markers={[{ id: 'me', position, kind: 'driver' }]} />
      </View>

      <View style={styles.sheet}>
        <View style={styles.grip} />

        {error && <Banner text={error} tone="bad" />}
        {online && connection === 'reconnecting' && (
          <Banner text="Reconectando… seguimos consultando si hay viajes." tone="warn" />
        )}

        <View style={styles.statusRow}>
          <View style={styles.statusText}>
            <Text style={styles.statusTitle}>{online ? 'En línea' : 'Fuera de línea'}</Text>
            <Text style={styles.statusDetail}>
              {online ? 'Esperando viajes cerca de tu posición.' : 'No vas a recibir viajes.'}
            </Text>
          </View>
          <Switch
            value={online}
            onValueChange={(next) => void toggle(next)}
            disabled={busy}
            trackColor={{ false: colors.line, true: colors.brand }}
            thumbColor={colors.ink}
          />
        </View>

        {online && (
          <Banner
            text="La ubicación es de primer plano: si minimizás la app dejás de recibir viajes."
            tone="warn"
          />
        )}

        {/*
          Mostrar las coordenadas reportadas no es un lujo de depuración: es la
          única forma de que el conductor —o quien prueba— vea POR QUÉ no le
          llegan viajes.

          El caso concreto: el emulador de Android se ubica por defecto en
          Mountain View, California. El dispatch busca en un radio de pocos
          kilómetros del origen del viaje, así que no encuentra a nadie y todo
          termina en NO_DRIVERS sin ninguna pista de la causa. Con la posición a
          la vista, el problema se ve de inmediato.
        */}
        {online && (
          <View style={styles.coords}>
            <Text style={styles.coordsText}>
              {position.lat.toFixed(5)}, {position.lng.toFixed(5)}
            </Text>
            <Text style={[styles.coordsHint, !inMontevideo && styles.coordsWarn]}>
              {inMontevideo
                ? 'dentro de la zona operativa'
                : 'FUERA de Montevideo: no vas a recibir viajes'}
            </Text>
          </View>
        )}

        <Card>
          <Text style={styles.cardTitle}>Esta semana</Text>
          {earnings ? (
            <>
              <Row label="Viajes" value={String(earnings.thisWeek.trips)} />
              <Row label="Facturado" value={money(earnings.thisWeek.grossCents)} />
              <Row label="Comisión" value={money(earnings.thisWeek.commissionCents)} />
              <View style={styles.divider} />
              {earnings.pendingPayoutCents > 0 && (
                <Row label="Te debemos" value={money(earnings.pendingPayoutCents)} strong />
              )}
              {earnings.owedToPlatformCents > 0 && (
                <>
                  <Row label="Debés de comisión" value={money(earnings.owedToPlatformCents)} strong />
                  <Text style={styles.note}>
                    En los viajes en efectivo cobrás la tarifa completa, así que la comisión
                    queda a cobrar y se descuenta del próximo pago.
                  </Text>
                </>
              )}
              {earnings.pendingPayoutCents === 0 && earnings.owedToPlatformCents === 0 && (
                <Row label="Cuenta al día" value="Sin saldo" strong />
              )}
            </>
          ) : (
            <Text style={styles.note}>Cargando…</Text>
          )}
        </Card>

        <Text style={styles.who}>{me?.fullName}</Text>
        <Button label="Salir" variant="ghost" onPress={() => void logout()} />
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
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  statusText: { flex: 1 },
  statusTitle: { color: colors.ink, fontSize: 18, fontWeight: '800' },
  statusDetail: { color: colors.dim, fontSize: 12.5, marginTop: 2 },
  cardTitle: { color: colors.ink, fontSize: 14, fontWeight: '700', marginBottom: space.sm },
  divider: { height: 1, backgroundColor: colors.line, marginVertical: space.sm },
  note: { color: colors.dim2, fontSize: 11, lineHeight: 16, marginTop: space.xs },
  who: { color: colors.dim2, fontSize: 11, textAlign: 'center' },
  coords: { alignItems: 'center', gap: 1 },
  coordsText: { color: colors.dim, fontSize: 11.5, fontFamily: 'monospace' },
  coordsHint: { color: colors.dim2, fontSize: 10 },
  coordsWarn: { color: colors.bad, fontWeight: '700' },
});

import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as Location from 'expo-location';
import { humanMessage, type LatLng } from '@orbit/client';
import { OrbitMap } from '../components/OrbitMap';
import { Banner, Button } from '../components/ui';
import { colors, radius, space, km } from '../theme';
import { DESTINATIONS, MONTEVIDEO } from '../config';

export interface HomeResult {
  readonly origin: LatLng;
  readonly originAddress: string;
  readonly destination: LatLng;
  readonly destinationAddress: string;
}

/**
 * Mapa, origen por GPS y elección de destino.
 *
 * El origen arranca en el centro de Montevideo y se reemplaza cuando el GPS
 * responde. Mostrar el mapa vacío esperando el permiso de ubicación es la forma
 * más rápida de que alguien cierre la app.
 */
export function HomeScreen({ onQuote }: { onQuote: (result: HomeResult) => void }): React.ReactElement {
  const [origin, setOrigin] = useState<LatLng>(MONTEVIDEO);
  const [originLabel, setOriginLabel] = useState('Centro de Montevideo');
  const [locating, setLocating] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') {
          if (!cancelled) {
            setNotice('Sin permiso de ubicación usamos el centro de Montevideo como origen.');
          }
          return;
        }
        const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        if (cancelled) return;
        setOrigin({ lat: position.coords.latitude, lng: position.coords.longitude });
        setOriginLabel('Tu ubicación actual');
      } catch (error) {
        if (!cancelled) setNotice(humanMessage(error));
      } finally {
        if (!cancelled) setLocating(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <View style={styles.wrap}>
      <View style={styles.mapArea}>
        <OrbitMap center={origin} markers={[{ id: 'origin', position: origin, kind: 'origin' }]} />
      </View>

      <View style={styles.sheet}>
        <View style={styles.grip} />

        {notice && <Banner text={notice} tone="warn" />}

        <View style={styles.field}>
          <View style={[styles.dot, styles.dotOrigin]} />
          <View style={styles.fieldText}>
            <Text style={styles.fieldLabel}>ORIGEN</Text>
            <Text style={styles.fieldValue} numberOfLines={1}>
              {locating ? 'Detectando tu ubicación…' : originLabel}
            </Text>
          </View>
        </View>

        {!picking ? (
          <>
            <Pressable style={styles.field} onPress={() => setPicking(true)}>
              <View style={[styles.dot, styles.dotDest]} />
              <View style={styles.fieldText}>
                <Text style={styles.fieldLabel}>DESTINO</Text>
                <Text style={styles.fieldPlaceholder}>¿A dónde vamos?</Text>
              </View>
            </Pressable>
            <Button label="Elegir destino" onPress={() => setPicking(true)} />
          </>
        ) : (
          <>
            <Text style={styles.pickTitle}>¿A dónde vamos?</Text>
            <ScrollView style={styles.list}>
              {DESTINATIONS.map((place) => (
                <Pressable
                  key={place.name}
                  style={styles.place}
                  onPress={() =>
                    onQuote({
                      origin,
                      originAddress: originLabel,
                      destination: { lat: place.lat, lng: place.lng },
                      destinationAddress: `${place.name} — ${place.address}`,
                    })
                  }
                >
                  <Text style={styles.placeIcon}>{place.icon}</Text>
                  <View style={styles.placeText}>
                    <Text style={styles.placeName}>{place.name}</Text>
                    <Text style={styles.placeAddress}>{place.address}</Text>
                  </View>
                  <Text style={styles.placeKm}>
                    {km(haversine(origin, { lat: place.lat, lng: place.lng }))}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
            <Button label="Volver" variant="ghost" onPress={() => setPicking(false)} />
          </>
        )}
      </View>
    </View>
  );
}

/** Distancia aproximada, solo para ordenar la lista. La real la calcula el servidor. */
function haversine(a: LatLng, b: LatLng): number {
  const R = 6_371_008.8;
  const rad = (d: number): number => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.bg },
  mapArea: { flex: 1 },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderTopWidth: 1,
    borderColor: colors.line,
    padding: space.lg,
    paddingBottom: space.xl,
    gap: space.sm,
  },
  grip: { width: 38, height: 4, borderRadius: 2, backgroundColor: colors.line, alignSelf: 'center', marginBottom: space.md },
  field: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    backgroundColor: colors.surface2,
    borderWidth: 1, borderColor: colors.line,
    borderRadius: radius.md, padding: space.md,
  },
  fieldText: { flex: 1 },
  fieldLabel: { color: colors.dim2, fontSize: 9.5, fontWeight: '700', letterSpacing: 0.7 },
  fieldValue: { color: colors.ink, fontSize: 14, marginTop: 2 },
  fieldPlaceholder: { color: colors.dim2, fontSize: 14, marginTop: 2 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  dotOrigin: { backgroundColor: colors.ok },
  dotDest: { backgroundColor: colors.brand2, borderRadius: 2 },
  pickTitle: { color: colors.ink, fontSize: 17, fontWeight: '700', marginBottom: space.sm },
  list: { maxHeight: 300 },
  place: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md },
  placeIcon: { fontSize: 20, width: 34, textAlign: 'center' },
  placeText: { flex: 1 },
  placeName: { color: colors.ink, fontSize: 14, fontWeight: '600' },
  placeAddress: { color: colors.dim2, fontSize: 11.5, marginTop: 1 },
  placeKm: { color: colors.dim, fontSize: 11.5, fontVariant: ['tabular-nums'] },
});

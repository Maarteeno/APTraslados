/**
 * El auto del conductor, visto desde arriba.
 *
 * ── Por qué está dibujado con Views y no con un SVG ──────────────────────────
 *
 * `react-native-svg` no está instalado, y agregarlo por un ícono cuesta una
 * dependencia nativa nueva y un `expo prebuild` completo. Un auto visto de
 * arriba son cuatro rectángulos redondeados: no justifica el cambio.
 *
 * Si algún día entra SVG al proyecto por otra razón, este archivo es el primer
 * candidato a reescribirse — pero no al revés.
 *
 * ── Por qué un auto y no un punto ────────────────────────────────────────────
 *
 * Un círculo no tiene frente. En una pantalla rotada al rumbo, la orientación
 * del vehículo es la mitad de la información: dice hacia dónde apunta la nariz
 * respecto de la calle. Con un punto hay que inferirlo del movimiento, y
 * detenido es imposible.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';
import { colors } from '../theme';

export function VehicleMarker({ bearing }: { bearing: number | null }): React.ReactElement {
  return (
    <View style={styles.wrap}>
      {/*
        El halo va debajo y no rota: da contraste sobre cualquier color de mapa
        —el auto solo se pierde sobre calles del mismo tono— y marca la posición
        aunque el vehículo esté girado.
      */}
      <View style={styles.halo} />

      <View style={[styles.car, { transform: [{ rotate: `${bearing ?? 0}deg` }] }]}>
        {/* Carrocería */}
        <View style={styles.body} />
        {/* Parabrisas, hacia adelante: es lo que deja leer para dónde apunta. */}
        <View style={styles.windshield} />
        {/* Techo */}
        <View style={styles.roof} />
        {/* Espejos, uno por lado. Chicos, pero rompen la silueta y a simple
            vista hacen que se lea "auto" y no "cápsula". */}
        <View style={[styles.mirror, styles.mirrorLeft]} />
        <View style={[styles.mirror, styles.mirrorRight]} />
      </View>
    </View>
  );
}

const CAR_W = 20;
const CAR_H = 34;

const styles = StyleSheet.create({
  wrap: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  halo: {
    position: 'absolute',
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.brand2,
    opacity: 0.18,
  },
  car: { width: CAR_W, height: CAR_H, alignItems: 'center' },
  body: {
    position: 'absolute',
    width: CAR_W,
    height: CAR_H,
    borderRadius: 7,
    backgroundColor: colors.brand2,
    borderWidth: 1.5,
    borderColor: colors.bg,
  },
  windshield: {
    position: 'absolute',
    top: 5,
    width: CAR_W - 8,
    height: 7,
    borderRadius: 3,
    backgroundColor: colors.bg,
    opacity: 0.85,
  },
  roof: {
    position: 'absolute',
    top: 14,
    width: CAR_W - 6,
    height: 12,
    borderRadius: 4,
    backgroundColor: colors.bg,
    opacity: 0.35,
  },
  mirror: {
    position: 'absolute',
    top: 9,
    width: 3.5,
    height: 5,
    borderRadius: 2,
    backgroundColor: colors.brand2,
  },
  mirrorLeft: { left: -3 },
  mirrorRight: { right: -3 },
});

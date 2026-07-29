/**
 * Cartel de navegación: la próxima maniobra, arriba de todo.
 *
 * Es la pieza que distingue "un mapa que se mueve" de un navegador. Está
 * diseñado para leerse de reojo a 50 km/h, y de ahí salen las decisiones de
 * formato:
 *
 *  - La DISTANCIA es lo más grande. Es lo que cambia todo el tiempo y lo que
 *    dice cuánto falta para actuar.
 *  - La FLECHA compite en tamaño con la distancia: en la práctica se lee el
 *    ícono antes que el texto.
 *  - La CALLE va abajo y en menor jerarquía. Confirma, no guía.
 *  - Alto contraste y nada de animaciones: cualquier movimiento acá roba
 *    atención que le corresponde a la calle.
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { describeStep, formatDistance, type RouteStep } from '@orbit/client';
import { colors, radius, space } from '../theme';

export function NavBanner({
  step, distanceMeters, offRoute,
}: {
  step: RouteStep | null;
  distanceMeters: number;
  /** Muy lejos de la ruta: se avisa en vez de dar una instrucción falsa. */
  offRoute: boolean;
}): React.ReactElement {
  const instruction = describeStep(step);

  if (offRoute) {
    return (
      <View style={[styles.wrap, styles.wrapWarn]}>
        <Text style={styles.arrow}>⚠</Text>
        <View style={styles.textCol}>
          <Text style={styles.action}>Estás fuera de la ruta</Text>
          <Text style={styles.street}>Volvé al trazado marcado en el mapa</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      <Text style={styles.arrow}>{instruction.arrow}</Text>
      <View style={styles.textCol}>
        <Text style={styles.distance}>{formatDistance(distanceMeters)}</Text>
        <Text style={styles.action} numberOfLines={1}>{instruction.action}</Text>
        {instruction.street.length > 0 && (
          <Text style={styles.street} numberOfLines={1}>{instruction.street}</Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: colors.bg,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: radius.lg,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    // Flota sobre el mapa: sin relieve se confunde con una etiqueta de calle.
    elevation: 6,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
  },
  wrapWarn: { borderColor: colors.warn },
  arrow: { color: colors.brand2, fontSize: 40, fontWeight: '700', width: 46, textAlign: 'center' },
  textCol: { flex: 1 },
  distance: { color: colors.ink, fontSize: 26, fontWeight: '800', letterSpacing: -0.5 },
  action: { color: colors.ink, fontSize: 15, fontWeight: '600' },
  street: { color: colors.dim, fontSize: 13, marginTop: 1 },
});

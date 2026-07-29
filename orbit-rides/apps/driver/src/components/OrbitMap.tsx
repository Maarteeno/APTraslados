/**
 * Mapa con MapLibre.
 *
 * Sin API key ni tarjeta: el estilo apunta a un proveedor de tiles libre,
 * configurable por EXPO_PUBLIC_MAP_STYLE_URL.
 *
 * El mapa está aislado acá a propósito. Si algún día se cambia a Google Maps o a
 * Mapbox, se reescribe este archivo y nada más: las pantallas hablan con `props`,
 * no con el SDK.
 *
 * NOTAS SOBRE LA API DE MAPLIBRE v11, porque no es la que uno adivina:
 *
 *  - El componente del mapa se llama `Map`, no `MapView`.
 *  - Los marcadores son `Marker` con prop `lngLat`, no `MarkerView` con
 *    `coordinate`.
 *  - Las fuentes son `GeoJSONSource` con prop `data`, no `ShapeSource` con
 *    `shape`.
 *  - Las capas son un único `Layer` con `type: 'line'`, no un `LineLayer`.
 *  - **No hay export por defecto y no existe `setAccessToken`.** Eso es de
 *    Mapbox; MapLibre no usa tokens, que es justamente por lo que lo elegimos.
 *  - Las coordenadas van como `[lng, lat]` y los bounds como
 *    `[oeste, sur, este, norte]`. Invertirlos no da error: dibuja en el océano.
 *  - En las capas, `style` está deprecado desde v11; lo vigente es `paint` y
 *    `layout`.
 *  - Los ornamentos son `logo`, `attribution`, `compass` y `scaleBar` — sin el
 *    sufijo `Enabled`.
 *  - `ViewPadding` usa `top/right/bottom/left`, no `paddingTop/...`. Se parece
 *    al objeto de estilos de React Native pero no lo es.
 *  - **No tocar la cámara antes de que el estilo cargue.** `jumpTo`, `flyTo` y
 *    `fitBounds` sobre un mapa que todavía no montó su vista nativa pueden
 *    tirar la app. Acá se espera a `onDidFinishLoadingStyle`.
 *  - **La cámara necesita `initialViewState` y nada más en props.** Los
 *    movimientos van por el ref (`jumpTo`, `flyTo`, `fitBounds`). Pasar además
 *    `center`/`zoom` como props crea dos fuentes en conflicto; no pasar estado
 *    inicial deja la cámara sin posición. Las dos formas producen el MISMO
 *    síntoma: mapa negro y ningún error, porque MapLibre no se queja de una
 *    cámara indefinida, simplemente no dibuja.
 *  - **Cuidado con el padding de `fitBounds`.** Si la suma de los márgenes se
 *    acerca al tamaño del mapa, no queda viewport y MapLibre compensa alejando
 *    la cámara hasta que los bounds entren. El síntoma es un mapa que muestra
 *    medio continente en vez de un recorrido de 18 km.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  Camera, GeoJSONSource, Layer, Map, Marker,
  type CameraRef, type LngLat, type LngLatBounds,
} from '@maplibre/maplibre-react-native';
import { colors } from '../theme';
import { config } from '../config';
import type { LatLng } from '@orbit/client';

export interface MapMarker {
  readonly id: string;
  readonly position: LatLng;
  readonly kind: 'origin' | 'destination' | 'driver';
}

export interface OrbitMapProps {
  readonly center: LatLng;
  readonly zoom?: number;
  readonly markers?: readonly MapMarker[];
  /** Línea entre puntos, para la ruta o el acercamiento del conductor. */
  readonly route?: readonly LatLng[];
  /** Encuadra todos los marcadores en vez de centrar en `center`. */
  readonly fitAll?: boolean;
  /**
   * Margen en píxeles al encuadrar.
   *
   * Es prop y no constante porque depende del layout: si la hoja inferior
   * FLOTA sobre el mapa hace falta margen abajo, y si va DEBAJO no hace falta
   * ninguno. Poner 320 abajo sobre un mapa de 380 px de alto no deja viewport y
   * MapLibre compensa alejándose hasta mostrar medio continente. Fue
   * exactamente el bug.
   */
  readonly fitPadding?: number;
}

/** LatLng del dominio ({lat,lng}) al par [lng,lat] que espera MapLibre. */
function toLngLat(point: LatLng): LngLat {
  return [point.lng, point.lat];
}

export function OrbitMap({
  center, zoom = 13, markers = [], route, fitAll = false, fitPadding = 48,
}: OrbitMapProps): React.ReactElement {
  const cameraRef = useRef<CameraRef>(null);

  /**
   * Estado de carga del estilo.
   *
   * Un mapa en negro sin explicación es la peor forma de fallar: no se distingue
   * "sin red" de "estilo mal" de "bug en la cámara". MapLibre avisa cuándo
   * termina de cargar y cuándo falla; se muestra en pantalla en vez de quedar
   * enterrado en logcat.
   */
  const [styleState, setStyleState] = useState<'loading' | 'ready' | 'failed'>('loading');

  const onStyleReady = useCallback(() => setStyleState('ready'), []);
  const onMapFailed = useCallback(() => setStyleState('failed'), []);

  /**
   * Clave estable de las posiciones.
   *
   * `markers` es un array nuevo en cada render, así que usarlo como dependencia
   * del efecto dispara fitBounds en cada render y el mapa tiembla. Lo que
   * importa es si las COORDENADAS cambiaron, no la identidad del array.
   */
  const markerKey = markers
    .map((m) => `${m.position.lat.toFixed(6)},${m.position.lng.toFixed(6)}`)
    .join('|');

  /**
   * Sigue el centro cuando no se encuadran marcadores.
   *
   * Va por el ref y no por props para no competir con `initialViewState`.
   * `jumpTo` en el primer movimiento y `flyTo` después: animar el salto inicial
   * desde la posición por defecto hasta la real se ve como un tirón raro.
   */
  const hasCentered = useRef(false);

  useEffect(() => {
    // Nada de tocar la cámara antes de que el estilo esté cargado.
    //
    // Este efecto corre al montar, y en ese momento el mapa nativo todavía no
    // existe: llamar jumpTo/flyTo/fitBounds ahí es una causa conocida de crash
    // en MapLibre. El `styleState` es la señal de que la vista nativa está lista.
    if (styleState !== 'ready' || fitAll) return;
    const target = { center: toLngLat(center), zoom };
    if (hasCentered.current) {
      cameraRef.current?.flyTo({ ...target, duration: 500 });
    } else {
      cameraRef.current?.jumpTo(target);
      hasCentered.current = true;
    }
  }, [styleState, fitAll, center.lat, center.lng, zoom]);

  useEffect(() => {
    if (styleState !== 'ready') return;
    if (!fitAll || markers.length < 2) return;
    const lats = markers.map((m) => m.position.lat);
    const lngs = markers.map((m) => m.position.lng);

    // Orden obligatorio: oeste, sur, este, norte.
    const bounds: LngLatBounds = [
      Math.min(...lngs), Math.min(...lats),
      Math.max(...lngs), Math.max(...lats),
    ];

    cameraRef.current?.fitBounds(bounds, {
      // ViewPadding usa top/right/bottom/left, NO paddingTop/paddingRight: no es
      // el objeto de estilos de React Native aunque se parezca.
      padding: { top: fitPadding, right: fitPadding, bottom: fitPadding, left: fitPadding },
      duration: 600,
    });
    // markerKey en vez de markers: ver el comentario de arriba.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [styleState, fitAll, markerKey, fitPadding]);

  const line: GeoJSON.Feature<GeoJSON.LineString> | null =
    route && route.length >= 2
      ? {
          type: 'Feature',
          properties: {},
          geometry: { type: 'LineString', coordinates: route.map(toLngLat) },
        }
      : null;

  return (
    <View style={styles.container}>
      <Map
        style={styles.map}
        mapStyle={config.mapStyleUrl}
        logo={false}
        attribution
        compass={false}
        onDidFinishLoadingStyle={onStyleReady}
        onDidFailLoadingMap={onMapFailed}
      >
        {/*
          `initialViewState` SIEMPRE, y los movimientos por el ref.

          Dos formas de equivocarse acá, y probé las dos antes de dar con esta:

          1. Pasar `initialViewState` Y `center`/`zoom` al mismo tiempo: dos
             fuentes compitiendo por la misma cámara.
          2. Pasar solo `center`/`zoom` sin estado inicial: la cámara arranca sin
             posición definida y anima desde la nada.

          Las dos se ven igual —mapa NEGRO, sin ningún error— porque MapLibre no
          se queja de una cámara indefinida, simplemente no dibuja.

          Con estado inicial garantizado y los cambios aplicados por el ref, la
          cámara siempre tiene una posición válida.
        */}
        <Camera ref={cameraRef} initialViewState={{ center: toLngLat(center), zoom }} />

        {line && (
          <GeoJSONSource id="route" data={line}>
            <Layer
              id="route-line"
              type="line"
              paint={{ 'line-color': colors.brand2, 'line-width': 4 }}
              layout={{ 'line-cap': 'round', 'line-join': 'round' }}
            />
          </GeoJSONSource>
        )}

        {markers.map((marker) => (
          <Marker key={marker.id} lngLat={toLngLat(marker.position)}>
            <View style={[styles.pin, styles[marker.kind]]} />
          </Marker>
        ))}
      </Map>

      {styleState !== 'ready' && (
        <View style={styles.overlay} pointerEvents="none">
          <Text style={styles.overlayText}>
            {styleState === 'loading' ? 'Cargando el mapa…' : 'El mapa no cargó'}
          </Text>
          {styleState === 'failed' && (
            <Text style={styles.overlayHint}>
              Revisá la conexión. MapLibre no usa API key, así que no es un problema de
              credenciales.
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  map: { flex: 1 },
  overlay: {
    position: 'absolute',
    left: 0, right: 0, top: 0, bottom: 0,
    alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 32, gap: 6,
  },
  overlayText: { color: colors.dim, fontSize: 13 },
  overlayHint: { color: colors.dim2, fontSize: 11, textAlign: 'center', lineHeight: 16 },
  pin: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 3,
    borderColor: colors.bg,
  },
  origin: { backgroundColor: colors.ok },
  destination: { backgroundColor: colors.brand2 },
  driver: { backgroundColor: colors.warn, width: 22, height: 22, borderRadius: 11 },
});

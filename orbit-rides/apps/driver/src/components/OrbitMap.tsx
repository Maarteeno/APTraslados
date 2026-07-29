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
 * ── LOS TRES ESTADOS DE CÁMARA ───────────────────────────────────────────────
 *
 * Es el modelo que usan las SDK de navegación de Google y de Mapbox, y llegamos
 * a él después de romperlo de las dos formas posibles:
 *
 *   following  la cámara se pega al usuario, con zoom cerrado, inclinación y
 *              rotación según el rumbo. Es el "modo GPS".
 *   overview   encuadra TODO lo que importa —el trazado y los marcadores— para
 *              ver el recorrido completo.
 *   idle       el usuario movió el mapa con los dedos. La cámara NO toca nada
 *              hasta que él pida volver.
 *
 * El tercero es el que suele faltar, y su ausencia se nota enseguida: sin él,
 * cada vez que el usuario aleja el mapa para mirar el recorrido, la siguiente
 * actualización de posición lo devuelve de un tirón a donde estaba. El mapa
 * pelea contra el dedo y gana siempre.
 *
 * Se detecta con el flag `userInteraction` del evento de cambio de viewport, que
 * el lado nativo evalúa antes de mandarlo: distingue un gesto real de nuestros
 * propios `flyTo`. OJO con el nombre — la documentación vieja lo llama
 * `isUserInteraction`, pero en esta versión es `userInteraction`, sin el "is".
 *
 * ── NOTAS SOBRE LA API DE MAPLIBRE v11, porque no es la que uno adivina ──────
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
 *    movimientos van por el ref. Pasar además `center`/`zoom` como props crea
 *    dos fuentes en conflicto; no pasar estado inicial deja la cámara sin
 *    posición. Las dos formas producen el MISMO síntoma: mapa negro y ningún
 *    error, porque MapLibre no se queja de una cámara indefinida, simplemente
 *    no dibuja.
 *  - **Cuidado con el padding de `fitBounds`.** Si la suma de los márgenes se
 *    acerca al tamaño del mapa, no queda viewport y MapLibre compensa alejando
 *    la cámara hasta que los bounds entren. El síntoma es un mapa que muestra
 *    medio continente en vez de un recorrido de 18 km.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  Camera, GeoJSONSource, Layer, Map, Marker,
  type CameraRef, type LngLat, type LngLatBounds, type ViewStateChangeEvent,
} from '@maplibre/maplibre-react-native';
import type { NativeSyntheticEvent } from 'react-native';
import { colors } from '../theme';
import { VehicleMarker } from './VehicleMarker';
import { config } from '../config';
import type { LatLng } from '@orbit/client';

export interface MapMarker {
  readonly id: string;
  readonly position: LatLng;
  readonly kind: 'origin' | 'destination' | 'driver';
  /**
   * Rumbo del vehículo, solo para `driver`.
   *
   * Se pasa por marcador y no como prop suelta del mapa porque es un atributo
   * de ESE marcador: el día que haya varios vehículos en pantalla —el conductor
   * y los otros cerca— cada uno apunta a su lado.
   */
  readonly bearing?: number | null;
}

/** Modo de cámara pedido por la pantalla. El `idle` es interno, no se pide. */
export type CameraMode = 'follow' | 'overview';

export interface OrbitMapProps {
  readonly center: LatLng;
  readonly zoom?: number;
  readonly markers?: readonly MapMarker[];
  /** Trazado principal: el camino que hay que recorrer AHORA. */
  readonly route?: readonly LatLng[];
  /**
   * Trazado secundario, en tenue.
   *
   * Sirve para mostrar el resto del viaje mientras el conductor va a buscar al
   * pasajero: la línea brillante es hasta dónde tiene que ir ahora, la tenue es
   * lo que viene después. Sin esta distinción, dos líneas del mismo color se
   * leen como una sola ruta confusa.
   */
  readonly contextRoute?: readonly LatLng[];
  /**
   * Modo pedido. `overview` encuadra el recorrido, `follow` sigue a `center`.
   *
   * Si el usuario mueve el mapa, se pasa a idle y este modo queda como el
   * destino del botón de volver.
   */
  readonly mode?: CameraMode;
  /**
   * Rumbo en grados para rotar en modo follow.
   *
   * Con null el norte queda arriba. Rotar exige un rumbo confiable: con el
   * vehículo detenido el GPS devuelve valores aleatorios y el mapa gira solo.
   */
  readonly bearing?: number | null;
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
  /** Si se pasa, aparece el botón para alternar entre seguir y ver el recorrido. */
  readonly onModeChange?: (mode: CameraMode) => void;
  /**
   * Separación de los controles respecto del borde inferior, en píxeles.
   *
   * Existe porque en modo navegación la pantalla pone sus propios indicadores
   * abajo —velocidad, distancia, llegada— y sin correr los controles quedarían
   * uno encima del otro.
   */
  readonly controlsBottom?: number;
}

/** Zoom e inclinación del modo seguimiento. Suficiente para ver la próxima esquina. */
const FOLLOW_ZOOM = 16.5;
const FOLLOW_PITCH = 50;

/**
 * Duración de la animación de seguimiento.
 *
 * 900 ms contra un reporte de posición cada 8 s (POSITION_INTERVAL_MS). El
 * margen importa: si la animación durara más que el intervalo, cada posición
 * nueva cortaría la anterior a mitad de camino y el mapa daría tirones en vez
 * de deslizarse.
 */
const FOLLOW_MS = 900;

/** LatLng del dominio ({lat,lng}) al par [lng,lat] que espera MapLibre. */
function toLngLat(point: LatLng): LngLat {
  return [point.lng, point.lat];
}

/**
 * Caja que contiene todos los puntos, en el orden que pide MapLibre.
 *
 * Incluye el TRAZADO y no solo los marcadores. Encuadrar solo por marcadores
 * recorta las rutas que se apartan de la recta entre origen y destino —que en
 * una ciudad son casi todas— y deja al conductor mirando un tramo cortado.
 */
function boundsOf(points: readonly LatLng[]): LngLatBounds | null {
  if (points.length === 0) return null;
  const lats = points.map((p) => p.lat);
  const lngs = points.map((p) => p.lng);
  // Orden obligatorio: oeste, sur, este, norte.
  return [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)];
}

function lineFeature(points: readonly LatLng[]): GeoJSON.Feature<GeoJSON.LineString> | null {
  if (points.length < 2) return null;
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates: points.map(toLngLat) },
  };
}

export function OrbitMap({
  center, zoom = 13, markers = [], route, contextRoute,
  mode = 'overview', bearing = null, fitPadding = 48, onModeChange,
  controlsBottom = 12,
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

  /** El usuario movió el mapa: la cámara se calla hasta que pida volver. */
  const [idle, setIdle] = useState(false);

  /**
   * Alto del mapa, para correr el vehículo hacia abajo en modo follow.
   *
   * En un navegador el auto NO va al centro: va en el tercio inferior, para que
   * la pantalla la ocupe el camino que viene y no el que ya se recorrió. Eso se
   * consigue con el `padding` de la cámara, que corre el punto de enfoque. Y el
   * padding se expresa en píxeles, así que hay que medir la vista.
   */
  const [height, setHeight] = useState(0);

  const onStyleReady = useCallback(() => setStyleState('ready'), []);
  const onMapFailed = useCallback(() => setStyleState('failed'), []);

  const onRegionDidChange = useCallback(
    (event: NativeSyntheticEvent<ViewStateChangeEvent>) => {
      // `userInteraction` lo evalúa el lado nativo con el reconocedor de gestos
      // ANTES de cruzar el puente, así que distingue un dedo de nuestros flyTo.
      if (event.nativeEvent.userInteraction) setIdle(true);
    },
    [],
  );

  // Cambiar de modo es una orden explícita de la pantalla: cancela el idle.
  useEffect(() => { setIdle(false); }, [mode]);

  /**
   * Clave estable de las posiciones a encuadrar.
   *
   * Las props son arrays nuevos en cada render, así que usarlas como dependencia
   * dispara fitBounds en cada render y el mapa tiembla. Lo que importa es si las
   * COORDENADAS cambiaron, no la identidad del array.
   *
   * Se redondea a cinco decimales, poco más de un metro: un jitter de GPS por
   * debajo de eso no justifica volver a encuadrar.
   */
  const overviewPoints = useMemo(
    () => [...(route ?? []), ...(contextRoute ?? []), ...markers.map((m) => m.position)],
    [route, contextRoute, markers],
  );
  const overviewKey = overviewPoints
    .map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`)
    .join('|');

  /**
   * Cámara en modo overview: encuadra todo el recorrido.
   *
   * Va por el ref y no por props para no competir con `initialViewState`.
   */
  const hasFramed = useRef(false);
  useEffect(() => {
    if (styleState !== 'ready' || idle || mode !== 'overview') return;

    const bounds = boundsOf(overviewPoints);
    if (!bounds) return;

    // Con un solo punto —o todos en el mismo lugar— fitBounds no tiene caja que
    // encuadrar y MapLibre se aleja sin límite. Se centra a mano.
    const [west, south, east, north] = bounds;
    if (east - west < 1e-6 && north - south < 1e-6) {
      const target = { center: toLngLat({ lat: south, lng: west }), zoom, pitch: 0, bearing: 0 };
      if (hasFramed.current) cameraRef.current?.flyTo({ ...target, duration: 500 });
      else { cameraRef.current?.jumpTo(target); hasFramed.current = true; }
      return;
    }

    cameraRef.current?.fitBounds(bounds, {
      // ViewPadding usa top/right/bottom/left, NO paddingTop/paddingRight: no es
      // el objeto de estilos de React Native aunque se parezca.
      padding: { top: fitPadding, right: fitPadding, bottom: fitPadding, left: fitPadding },
      // Volver a cero: si se venía de follow, la inclinación y la rotación
      // heredadas hacen que el recorrido se lea torcido.
      pitch: 0,
      bearing: 0,
      duration: 600,
    });
    hasFramed.current = true;
    // overviewKey en vez de overviewPoints: ver el comentario de arriba.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [styleState, idle, mode, overviewKey, fitPadding, zoom]);

  /**
   * Cámara en modo follow: pegada a `center`.
   *
   * ALTERNATIVA NATIVA, sin probar todavía: el componente `Camera` acepta
   * `trackUserLocation="course"`, que centra en la ubicación del usuario y usa
   * la dirección de marcha como rumbo, resuelto del lado nativo. Sería más
   * suave que animar desde JS.
   *
   * No se usa acá porque toma el control de la cámara, y esta pantalla también
   * necesita el modo overview y el idle. Si el seguimiento se siente
   * entrecortado en un teléfono real —el emulador no sirve para juzgarlo,
   * porque está quieto— probar esa vía antes de ajustar duraciones acá.
   */
  useEffect(() => {
    if (styleState !== 'ready' || idle || mode !== 'follow') return;
    cameraRef.current?.flyTo({
      center: toLngLat(center),
      zoom: FOLLOW_ZOOM,
      pitch: FOLLOW_PITCH,
      // Solo se rota con un rumbo real; si no, el norte arriba.
      bearing: bearing ?? 0,
      // Reservar espacio ARRIBA empuja el punto de enfoque hacia abajo: el auto
      // queda en el tercio inferior y el camino que viene ocupa la pantalla.
      // Con la vista todavía sin medir se deja sin padding, que es el
      // comportamiento anterior y no rompe nada.
      ...(height > 0 ? { padding: { top: height * 0.45, right: 0, bottom: 0, left: 0 } } : {}),
      duration: FOLLOW_MS,
    });
  }, [styleState, idle, mode, center.lat, center.lng, bearing, height]);

  const mainLine = lineFeature(route ?? []);
  const contextLine = lineFeature(contextRoute ?? []);

  const recenterLabel = mode === 'follow' ? 'Centrar en mí' : 'Ver el recorrido';
  const toggleLabel = mode === 'follow' ? 'Ver el recorrido' : 'Seguirme';

  return (
    <View
      style={styles.container}
      onLayout={(e) => setHeight(e.nativeEvent.layout.height)}
    >
      <Map
        style={styles.map}
        mapStyle={config.mapStyleUrl}
        logo={false}
        attribution
        compass={false}
        onDidFinishLoadingStyle={onStyleReady}
        onDidFailLoadingMap={onMapFailed}
        onRegionDidChange={onRegionDidChange}
      >
        {/*
          `initialViewState` SIEMPRE, y los movimientos por el ref.

          Dos formas de equivocarse acá, y se probaron las dos antes de dar con
          esta:

          1. Pasar `initialViewState` Y `center`/`zoom` al mismo tiempo: dos
             fuentes compitiendo por la misma cámara.
          2. Pasar solo `center`/`zoom` sin estado inicial: la cámara arranca sin
             posición definida y anima desde la nada.

          Las dos se ven igual —mapa NEGRO, sin ningún error— porque MapLibre no
          se queja de una cámara indefinida, simplemente no dibuja.
        */}
        <Camera ref={cameraRef} initialViewState={{ center: toLngLat(center), zoom }} />

        {/* El contexto va PRIMERO: las capas se dibujan en orden y la línea
            principal tiene que quedar por encima. */}
        {contextLine && (
          <GeoJSONSource id="route-context" data={contextLine}>
            <Layer
              id="route-context-line"
              type="line"
              paint={{ 'line-color': colors.dim2, 'line-width': 4, 'line-opacity': 0.5 }}
              layout={{ 'line-cap': 'round', 'line-join': 'round' }}
            />
          </GeoJSONSource>
        )}

        {mainLine && (
          <GeoJSONSource id="route" data={mainLine}>
            {/* Dos capas sobre la misma fuente: una gruesa oscura debajo y la de
                color encima. Sin el contorno, una línea clara sobre calles
                claras se pierde. */}
            <Layer
              id="route-casing"
              type="line"
              paint={{ 'line-color': colors.bg, 'line-width': 9, 'line-opacity': 0.9 }}
              layout={{ 'line-cap': 'round', 'line-join': 'round' }}
            />
            <Layer
              id="route-line"
              type="line"
              paint={{ 'line-color': colors.brand2, 'line-width': 5 }}
              layout={{ 'line-cap': 'round', 'line-join': 'round' }}
            />
          </GeoJSONSource>
        )}

        {markers.map((marker) => (
          <Marker key={marker.id} lngLat={toLngLat(marker.position)}>
            {marker.kind === 'driver'
              ? <VehicleMarker bearing={marker.bearing ?? null} />
              : <View style={[styles.pin, styles[marker.kind]]} />}
          </Marker>
        ))}
      </Map>

      {/*
        Controles.

        El de volver aparece SOLO en idle, que es la regla de las SDK de
        navegación: en following no se muestra, porque no hay nada que recentrar.
      */}
      <View style={[styles.controls, { bottom: controlsBottom }]} pointerEvents="box-none">
        {idle && (
          <Pressable style={styles.control} onPress={() => setIdle(false)}>
            <Text style={styles.controlText}>{recenterLabel}</Text>
          </Pressable>
        )}
        {onModeChange && !idle && (
          <Pressable
            style={styles.control}
            onPress={() => onModeChange(mode === 'follow' ? 'overview' : 'follow')}
          >
            <Text style={styles.controlText}>{toggleLabel}</Text>
          </Pressable>
        )}
      </View>

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
  controls: {
    position: 'absolute',
    right: 12,
    alignItems: 'flex-end',
    gap: 8,
  },
  control: {
    backgroundColor: colors.bg,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 9,
    // Sombra: el control flota sobre el mapa y sin relieve se confunde con una
    // etiqueta de calle.
    elevation: 4,
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  controlText: { color: colors.ink, fontSize: 12, fontWeight: '600' },
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

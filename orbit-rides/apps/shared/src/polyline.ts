/**
 * Decodificador de polilíneas codificadas (Encoded Polyline Algorithm).
 *
 * OSRM devuelve el trazado como una cadena compacta en vez de un array de
 * coordenadas: una ruta urbana de 6 km son cientos de puntos, y en JSON crudo
 * pesa varias veces más que codificada.
 *
 * ── Por qué está escrito a mano y no con una dependencia ─────────────────────
 *
 * Son treinta líneas y el formato está congelado desde 2010. Una dependencia
 * más en una app React Native cuesta tamaño de bundle, una superficie de
 * suministro que auditar, y un candidato más a romperse en cada actualización
 * de Metro. No compensa.
 *
 * ── La trampa de la precisión ────────────────────────────────────────────────
 *
 * Hay dos variantes del formato y se ven idénticas:
 *
 *   polyline5  precisión 1e5  — el clásico de Google Maps, el default
 *   polyline6  precisión 1e6  — el que pedimos a OSRM con geometries=polyline6
 *
 * Decodificar una con el factor de la otra NO da error: da coordenadas diez
 * veces más chicas. Un trazado de Montevideo aparece cerca del golfo de Guinea,
 * el mapa se aleja para encuadrarlo y uno pasa una tarde buscando el bug en la
 * cámara. Por eso `precision` es un parámetro explícito con default 6, que es
 * lo que este proyecto usa, y por eso hay un test con un caso conocido.
 */

export interface DecodedPoint {
  readonly lat: number;
  readonly lng: number;
}

/**
 * Convierte una polilínea codificada en coordenadas.
 *
 * Devuelve un array vacío ante una entrada vacía o nula: los trazados son
 * opcionales en toda la API —la estimación local no produce geometría— y hacer
 * que el llamador se defienda de un null en cada pantalla no aporta nada.
 */
export function decodePolyline(encoded: string | null | undefined, precision = 6): DecodedPoint[] {
  if (!encoded) return [];

  const factor = Math.pow(10, precision);
  const points: DecodedPoint[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    // Cada coordenada es un delta respecto de la anterior, en zigzag y en
    // grupos de 5 bits. Se leen primero los de latitud y después los de
    // longitud; si la cadena se corta a la mitad de un grupo, el bucle interno
    // termina por fin de cadena y el punto queda descartado abajo.
    let result = 0;
    let shift = 0;
    let byte: number;

    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length);
    // Zigzag: el bit menos significativo indica el signo.
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 0;
    shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    const point = { lat: lat / factor, lng: lng / factor };
    // Una cadena corrupta puede producir coordenadas fuera del planeta. Se
    // descartan en vez de dibujarlas: un punto imposible dentro del trazado
    // hace que fitBounds encuadre medio mundo y el recorrido desaparezca.
    if (Number.isFinite(point.lat) && Number.isFinite(point.lng) &&
        Math.abs(point.lat) <= 90 && Math.abs(point.lng) <= 180) {
      points.push(point);
    }
  }

  return points;
}

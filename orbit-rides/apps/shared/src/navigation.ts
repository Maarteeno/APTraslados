/**
 * Progreso sobre la ruta e instrucciones de navegación.
 *
 * Responde la única pregunta que importa mientras se maneja: **¿qué tengo que
 * hacer en la próxima esquina y a cuántos metros?**
 *
 * ── Por qué no alcanza con las distancias que da OSRM ────────────────────────
 *
 * Cada paso trae su propia `distance`, y es tentador ir restando: «llevo 300 m,
 * el primer paso medía 200, entonces estoy en el segundo». No funciona, por dos
 * razones:
 *
 *  1. La geometría que pedimos es `simplified`, así que la suma de las
 *     distancias de los pasos NO coincide con el largo del trazado que se
 *     dibuja. El error se acumula y a mitad de viaje el cartel adelanta o
 *     atrasa una maniobra entera.
 *  2. El conductor no avanza en línea recta sobre la lista de pasos: se desvía,
 *     lo desvían, o el GPS salta media cuadra. Un contador no tiene forma de
 *     recuperarse de eso.
 *
 * Lo que sí funciona —y es lo que hacen las SDK de navegación— es PROYECTAR la
 * posición sobre el trazado y medir todo sobre esa misma línea: dónde estoy,
 * dónde está la próxima maniobra, cuánto falta. Todas las medidas quedan en el
 * mismo sistema y los errores no se acumulan.
 *
 * ── Todo en metros y sobre una esfera ────────────────────────────────────────
 *
 * A escala de una ciudad, la Tierra se puede tratar como un plano localmente:
 * se convierten los grados a metros con el coseno de la latitud y se hace
 * geometría plana. El error a 5 km es de centímetros, y a cambio la proyección
 * punto-segmento se vuelve trivial en vez de trigonometría esférica.
 */

export interface NavPoint {
  readonly lat: number;
  readonly lng: number;
}

/** Maniobra tal como la emite el API. `type` y `modifier` son crudos de OSRM. */
export interface RouteStep {
  readonly distanceMeters: number;
  readonly durationSeconds: number;
  readonly name: string;
  readonly type: string;
  readonly modifier: string | null;
  readonly at: NavPoint;
  readonly exit: number | null;
}

export interface NavProgress {
  /** Índice del paso hacia el que se está yendo. */
  readonly stepIndex: number;
  /** El paso en sí, o null si la ruta se terminó. */
  readonly step: RouteStep | null;
  /** Metros hasta la maniobra, medidos SOBRE el trazado. */
  readonly distanceToManeuverMeters: number;
  /** Metros que faltan hasta el final del trazado. */
  readonly remainingMeters: number;
  /** Cuán lejos está el conductor de la línea. Alto = se desvió. */
  readonly offRouteMeters: number;
  /** Punto del trazado más cercano al conductor: dónde "está" sobre la ruta. */
  readonly snapped: NavPoint;
}

const EARTH_RADIUS_M = 6_371_000;
const DEG = Math.PI / 180;

/**
 * Metros por grado en cada eje, a una latitud dada.
 *
 * La longitud se acorta con el coseno de la latitud: en Montevideo (-34.9°) un
 * grado de longitud son unos 91 km contra los 111 km de uno de latitud. Ignorar
 * esa corrección deforma todas las distancias un 18 % acá, y más cerca de los
 * polos.
 */
function metersPerDegree(lat: number): { x: number; y: number } {
  return {
    x: EARTH_RADIUS_M * DEG * Math.cos(lat * DEG),
    y: EARTH_RADIUS_M * DEG,
  };
}

/** Distancia en metros entre dos puntos, plano local. Suficiente a escala urbana. */
export function metersBetween(a: NavPoint, b: NavPoint): number {
  const scale = metersPerDegree((a.lat + b.lat) / 2);
  const dx = (b.lng - a.lng) * scale.x;
  const dy = (b.lat - a.lat) * scale.y;
  return Math.hypot(dx, dy);
}

/** Rumbo en grados desde `a` hacia `b`, 0 = norte, sentido horario. */
export function bearingBetween(a: NavPoint, b: NavPoint): number {
  const scale = metersPerDegree((a.lat + b.lat) / 2);
  const dx = (b.lng - a.lng) * scale.x;
  const dy = (b.lat - a.lat) * scale.y;
  const deg = Math.atan2(dx, dy) / DEG;
  return (deg + 360) % 360;
}

export interface Projection {
  /** Índice del segmento donde cayó: el que va de path[i] a path[i+1]. */
  readonly segmentIndex: number;
  /** Punto sobre la línea más cercano a la posición. */
  readonly point: NavPoint;
  /** Metros recorridos sobre el trazado hasta ese punto. */
  readonly traveledMeters: number;
  /** Metros de separación entre la posición real y la línea. */
  readonly offRouteMeters: number;
}

/**
 * Proyecta una posición sobre el trazado.
 *
 * Recorre todos los segmentos y se queda con el más cercano. Es O(n) por
 * llamada, y con un trazado urbano de unos cientos de puntos y una actualización
 * cada pocos segundos eso es irrelevante. Optimizarlo con una ventana alrededor
 * de la última posición ahorraría microsegundos y agregaría un estado que puede
 * desincronizarse; no vale el cambio hasta que un perfilado diga lo contrario.
 */
export function projectOntoPath(
  path: readonly NavPoint[], position: NavPoint,
): Projection | null {
  if (path.length === 0) return null;
  const first = path[0] as NavPoint;
  if (path.length === 1) {
    return {
      segmentIndex: 0,
      point: first,
      traveledMeters: 0,
      offRouteMeters: metersBetween(first, position),
    };
  }

  const scale = metersPerDegree(position.lat);
  const toXY = (p: NavPoint): [number, number] => [p.lng * scale.x, p.lat * scale.y];
  const [px, py] = toXY(position);

  let best: Projection | null = null;
  let cumulative = 0;

  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i] as NavPoint;
    const b = path[i + 1] as NavPoint;
    const [ax, ay] = toXY(a);
    const [bx, by] = toXY(b);

    const vx = bx - ax;
    const vy = by - ay;
    const lengthSq = vx * vx + vy * vy;

    // Puntos duplicados: segmento de largo cero. Se saltea para no dividir por
    // cero; OSRM los emite de vez en cuando en las intersecciones.
    if (lengthSq === 0) continue;

    // t es dónde cae la perpendicular sobre el segmento, en [0,1]. Se satura:
    // si el conductor está antes del inicio o después del fin, el punto más
    // cercano del SEGMENTO es uno de sus extremos.
    const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / lengthSq));
    const cx = ax + t * vx;
    const cy = ay + t * vy;
    const distance = Math.hypot(px - cx, py - cy);

    if (!best || distance < best.offRouteMeters) {
      const segmentLength = Math.sqrt(lengthSq);
      best = {
        segmentIndex: i,
        point: { lat: cy / scale.y, lng: cx / scale.x },
        traveledMeters: cumulative + t * segmentLength,
        offRouteMeters: distance,
      };
    }
    cumulative += Math.sqrt(lengthSq);
  }

  return best;
}

/** Distancias acumuladas a lo largo del trazado, una por punto. */
export function cumulativeDistances(path: readonly NavPoint[]): number[] {
  const out: number[] = [0];
  for (let i = 1; i < path.length; i++) {
    out.push((out[i - 1] as number) + metersBetween(path[i - 1] as NavPoint, path[i] as NavPoint));
  }
  return out;
}

/**
 * Ubica al conductor sobre la ruta y decide qué maniobra viene.
 *
 * Las maniobras se ubican sobre el TRAZADO —no sobre sus propias distancias—
 * para que todo se mida con la misma vara. Ver el comentario de la cabecera.
 */
export function computeProgress(
  path: readonly NavPoint[],
  steps: readonly RouteStep[],
  position: NavPoint,
): NavProgress | null {
  const projection = projectOntoPath(path, position);
  if (!projection) return null;

  const cumulative = cumulativeDistances(path);
  const totalMeters = cumulative[cumulative.length - 1] ?? 0;

  // Dónde cae cada maniobra sobre el trazado.
  //
  // Se calcula acá y no se cachea a propósito: son unas decenas de maniobras y
  // un puñado de proyecciones. Cachearlo obligaría a invalidar cuando cambia la
  // ruta, que es justo el momento en que un caché mal invalidado hace que el
  // cartel señale la maniobra de la ruta anterior.
  const maneuverAt = steps.map((step) => {
    const p = projectOntoPath(path, step.at);
    return p ? p.traveledMeters : 0;
  });

  // La próxima maniobra es la primera que quedó por delante. Se descuentan diez
  // metros para que la instrucción no se quede pegada mientras se cruza la
  // esquina: sin ese margen, el cartel dice «girá acá» hasta pasarla.
  let stepIndex = maneuverAt.findIndex((m) => m > projection.traveledMeters + 10);
  if (stepIndex === -1) stepIndex = Math.max(0, steps.length - 1);

  const step = steps[stepIndex] ?? null;
  const maneuverDistance = maneuverAt[stepIndex] ?? totalMeters;

  return {
    stepIndex,
    step,
    distanceToManeuverMeters: Math.max(0, maneuverDistance - projection.traveledMeters),
    remainingMeters: Math.max(0, totalMeters - projection.traveledMeters),
    offRouteMeters: projection.offRouteMeters,
    snapped: projection.point,
  };
}

/**
 * Parte del trazado que todavía no se recorrió.
 *
 * Se dibuja solo esto en modo navegación. Mostrar la ruta entera hace que el
 * conductor no distinga de un vistazo qué le falta, que es la única pregunta
 * que se hace mirando el mapa.
 */
export function remainingPath(
  path: readonly NavPoint[], position: NavPoint,
): NavPoint[] {
  const projection = projectOntoPath(path, position);
  if (!projection) return [...path];
  // El punto proyectado va primero: si no, la línea arranca en el vértice
  // siguiente y se ve un salto entre el auto y el comienzo de la ruta.
  return [projection.point, ...path.slice(projection.segmentIndex + 1)];
}

// ───────────────────────────── Texto de las instrucciones ────────────────────

/**
 * Maniobra de OSRM a castellano rioplatense.
 *
 * El mapeo vive del lado del cliente y no del API a propósito: es texto de
 * interfaz. Si mañana hay que cambiar «girá» por «gire» para otro mercado, o
 * traducir a portugués para Brasil, se toca acá y el contrato del API no se
 * mueve. Por eso el servidor guarda `type` y `modifier` crudos.
 *
 * Los nombres salen de la especificación de OSRM. Los que no están mapeados
 * caen en un texto genérico en vez de mostrar el identificador en inglés: al
 * conductor «fork slight left» no le dice nada.
 */
const MODIFIER_TEXT: Record<string, string> = {
  left: 'a la izquierda',
  right: 'a la derecha',
  'slight left': 'levemente a la izquierda',
  'slight right': 'levemente a la derecha',
  'sharp left': 'cerrado a la izquierda',
  'sharp right': 'cerrado a la derecha',
  straight: 'derecho',
  uturn: 'en U',
};

export interface Instruction {
  /** Texto principal: qué hacer. */
  readonly action: string;
  /** Calle por la que se sigue. Puede estar vacía. */
  readonly street: string;
  /** Flecha para el ícono. */
  readonly arrow: string;
}

function arrowFor(type: string, modifier: string | null): string {
  if (type === 'arrive') return '◉';
  if (type === 'depart') return '↑';
  if (type === 'roundabout' || type === 'rotary') return '↻';
  switch (modifier) {
    case 'left': return '←';
    case 'right': return '→';
    case 'slight left': return '↖';
    case 'slight right': return '↗';
    case 'sharp left': return '↰';
    case 'sharp right': return '↱';
    case 'uturn': return '↺';
    default: return '↑';
  }
}

export function describeStep(step: RouteStep | null): Instruction {
  if (!step) return { action: 'Seguí por la ruta', street: '', arrow: '↑' };

  const street = step.name.trim();
  const dir = step.modifier ? MODIFIER_TEXT[step.modifier] ?? '' : '';
  const arrow = arrowFor(step.type, step.modifier);

  switch (step.type) {
    case 'depart':
      return { action: 'Arrancá', street, arrow };
    case 'arrive':
      return { action: 'Llegaste', street, arrow };
    case 'turn':
    case 'end of road':
    case 'fork':
      return { action: dir ? `Girá ${dir}` : 'Seguí', street, arrow };
    case 'new name':
    case 'continue':
      return { action: 'Seguí', street, arrow };
    case 'merge':
      return { action: dir ? `Incorporate ${dir}` : 'Incorporate', street, arrow };
    case 'on ramp':
      return { action: dir ? `Tomá la salida ${dir}` : 'Tomá la salida', street, arrow };
    case 'off ramp':
      return { action: dir ? `Salí ${dir}` : 'Salí', street, arrow };
    case 'roundabout':
    case 'rotary':
      return {
        action: step.exit ? `En la rotonda, salida ${step.exit}` : 'Entrá a la rotonda',
        street,
        arrow,
      };
    default:
      // Cualquier maniobra que OSRM agregue en el futuro cae acá con un texto
      // que al menos es correcto, en vez de mostrar el nombre en inglés.
      return { action: dir ? `Seguí ${dir}` : 'Seguí', street, arrow };
  }
}

/**
 * Distancia legible de un vistazo, manejando.
 *
 * Por debajo de 1 km se redondea a decenas: «en 247 m» obliga a leer tres
 * dígitos y no aporta nada sobre «en 250 m». Nadie mide su giro al metro.
 */
export function formatDistance(meters: number): string {
  if (meters < 20) return 'ahora';
  if (meters < 1000) return `en ${Math.round(meters / 10) * 10} m`;
  return `en ${(meters / 1000).toFixed(1).replace('.', ',')} km`;
}

/** Hora de llegada estimada, en formato de reloj de 24 h. */
export function formatArrival(secondsFromNow: number, now = new Date()): string {
  const arrival = new Date(now.getTime() + secondsFromNow * 1000);
  const hh = String(arrival.getHours()).padStart(2, '0');
  const mm = String(arrival.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

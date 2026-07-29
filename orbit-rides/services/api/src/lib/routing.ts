/**
 * Proveedor de ruteo.
 *
 * Interfaz primero, implementación después: mientras no haya API key de Mapbox
 * se usa una estimación local para poder desarrollar y probar en el emulador.
 * La estimación está marcada como tal en la respuesta (`provider`), así que
 * nunca se confunde con un ETA real en logs ni en la app.
 */

import { haversineMeters, type LatLng } from '@orbit/domain';

export class RoutingError extends Error {}

export type RouteProviderName = 'osrm' | 'mapbox' | 'estimate';

export interface RouteResult {
  readonly distanceMeters: number;
  readonly durationSeconds: number;
  readonly provider: RouteProviderName;
  readonly polyline: string | null;
  readonly steps: readonly RouteStep[];
}

/**
 * Una maniobra de la ruta, normalizada.
 *
 * Es un subconjunto deliberado de lo que devuelve OSRM. Se guardan solo los
 * campos que la app usa para el cartel de navegación; el resto —geometría por
 * paso, intersecciones, `bearing_before`— multiplica el tamaño de lo que viaja
 * al cliente y no se dibuja en ningún lado.
 *
 * `type` y `modifier` se dejan CRUDOS, con los nombres de OSRM. La traducción a
 * castellano vive en el cliente, junto al texto que se muestra: si el día de
 * mañana se cambia de proveedor de ruteo, se adapta el mapeo en un solo archivo
 * y el contrato del API no se mueve.
 */
export interface RouteStep {
  /** Largo del tramo que TERMINA en esta maniobra, en metros. */
  readonly distanceMeters: number;
  readonly durationSeconds: number;
  /** Nombre de la calle por la que se sigue después de la maniobra. */
  readonly name: string;
  /** `turn`, `new name`, `roundabout`, `arrive`… tal cual los nombra OSRM. */
  readonly type: string;
  /** `left`, `slight right`, `straight`… o null cuando la maniobra no lo tiene. */
  readonly modifier: string | null;
  /** Dónde ocurre la maniobra. */
  readonly at: LatLng;
  /** Salida de la rotonda, cuando aplica. */
  readonly exit: number | null;
}

/** Duración desde un origen hacia varios destinos, en segundos. */
export interface MatrixResult {
  readonly provider: RouteProviderName;
  /** Un valor por destino, en el mismo orden. null si no hay ruta posible. */
  readonly durationsSeconds: ReadonlyArray<number | null>;
}

export interface RoutingProvider {
  route(origin: LatLng, destination: LatLng): Promise<RouteResult>;
  /**
   * ETA de varios puntos hacia un destino común.
   *
   * Es la llamada del dispatch: cuántos segundos tarda cada conductor candidato
   * en llegar al origen del viaje. Escala con los INTENTOS de asignación, no con
   * los viajes cerrados, así que con un proveedor por request es la que domina
   * el costo. OSRM la resuelve local y gratis con /table.
   */
  matrix(sources: readonly LatLng[], destination: LatLng): Promise<MatrixResult>;
}

/**
 * Estimación local. Aplica un factor de sinuosidad porque la calle nunca es una
 * recta: en Montevideo la traza real está ~30 % por encima de la línea directa.
 */
export class EstimateRoutingProvider implements RoutingProvider {
  constructor(
    private readonly sinuosityFactor = 1.3,
    private readonly averageSpeedMps = 8.5,
  ) {}

  async route(origin: LatLng, destination: LatLng): Promise<RouteResult> {
    const straight = haversineMeters(origin, destination);
    const distanceMeters = Math.round(straight * this.sinuosityFactor);
    const durationSeconds = Math.max(60, Math.round(distanceMeters / this.averageSpeedMps));
    // Sin geometría no hay maniobras que dar: inventar «seguí derecho» sobre una
    // recta estimada sería peor que no decir nada.
    return { distanceMeters, durationSeconds, provider: 'estimate', polyline: null, steps: [] };
  }

  async matrix(sources: readonly LatLng[], destination: LatLng): Promise<MatrixResult> {
    const durationsSeconds = sources.map((source) => {
      const meters = haversineMeters(source, destination) * this.sinuosityFactor;
      return Math.max(30, Math.round(meters / this.averageSpeedMps));
    });
    return { provider: 'estimate', durationsSeconds };
  }
}

/** Forma cruda de un paso de OSRM. Solo los campos que se usan. */
interface OsrmStep {
  distance?: number;
  duration?: number;
  name?: string;
  maneuver?: {
    type?: string;
    modifier?: string;
    exit?: number;
    location?: [number, number];
  };
}

/**
 * Pasa los pasos de OSRM a nuestra forma.
 *
 * Se aplanan las `legs` porque nuestras rutas nunca tienen paradas intermedias:
 * siempre son origen→destino, así que hay una sola leg. Aplanar en vez de tomar
 * `legs[0]` cuesta lo mismo y no se rompe si algún día se agregan paradas.
 *
 * Los pasos sin `location` se descartan: sin el punto de la maniobra no se
 * puede ubicar sobre el trazado, y un cartel que no sabe dónde aparecer es peor
 * que ningún cartel.
 */
function normalizeSteps(legs: ReadonlyArray<{ steps?: OsrmStep[] }>): RouteStep[] {
  const out: RouteStep[] = [];
  for (const leg of legs) {
    for (const step of leg.steps ?? []) {
      const location = step.maneuver?.location;
      if (!location || location.length < 2) continue;
      const [lng, lat] = location;
      if (typeof lng !== 'number' || typeof lat !== 'number') continue;
      out.push({
        distanceMeters: Math.round(step.distance ?? 0),
        durationSeconds: Math.round(step.duration ?? 0),
        name: step.name ?? '',
        type: step.maneuver?.type ?? 'continue',
        modifier: step.maneuver?.modifier ?? null,
        // OSRM manda lon,lat. Invertirlo acá pone todas las maniobras en el
        // océano sin ningún error, igual que en `coord`.
        at: { lat, lng },
        exit: step.maneuver?.exit ?? null,
      });
    }
  }
  return out;
}

/**
 * OSRM autohospedado.
 *
 * Sin API key, sin cuota, sin tarjeta: corre en un contenedor al lado del API.
 * El endpoint /table da la matriz de ETA del dispatch, que es exactamente la
 * llamada que con un proveedor comercial domina la factura.
 *
 * Requiere que los datos estén preprocesados. Ver docker-compose:
 *   docker compose --profile prepare up osrm-download osrm-build
 */
export class OsrmRoutingProvider implements RoutingProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 3500,
  ) {}

  private coord(p: LatLng): string {
    // OSRM espera lon,lat — al revés de como se lee normalmente. Invertirlo
    // devuelve rutas en el océano sin ningún error, así que va en un solo lugar.
    return `${p.lng},${p.lat}`;
  }

  async route(origin: LatLng, destination: LatLng): Promise<RouteResult> {
    const url =
      `${this.baseUrl}/route/v1/driving/${this.coord(origin)};${this.coord(destination)}` +
      // steps=true trae las maniobras para el cartel de navegación. Encarece la
      // respuesta, pero se pide UNA vez por viaje —al cotizar y al aceptar—, no
      // en cada actualización de posición, así que el costo es despreciable
      // frente a /table, que es la llamada que sí escala.
      //
      // La geometría sigue en `simplified`: `full` multiplica los puntos por
      // varias veces para un dibujo que a escala de pantalla se ve igual.
      `?overview=simplified&geometries=polyline6&alternatives=false&steps=true`;

    const res = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) throw new RoutingError(`OSRM devolvió ${res.status}`);

    const body = (await res.json()) as {
      code?: string;
      routes?: Array<{
        distance: number;
        duration: number;
        geometry?: string;
        legs?: Array<{ steps?: OsrmStep[] }>;
      }>;
    };
    if (body.code !== 'Ok') throw new RoutingError(`OSRM: code=${body.code ?? 'ausente'}`);

    const route = body.routes?.[0];
    if (!route) throw new RoutingError('OSRM no devolvió ninguna ruta');

    return {
      distanceMeters: Math.round(route.distance),
      durationSeconds: Math.round(route.duration),
      provider: 'osrm',
      polyline: route.geometry ?? null,
      steps: normalizeSteps(route.legs ?? []),
    };
  }

  async matrix(sources: readonly LatLng[], destination: LatLng): Promise<MatrixResult> {
    if (sources.length === 0) return { provider: 'osrm', durationsSeconds: [] };

    // Todos los puntos en una sola lista: los orígenes primero y el destino al
    // final. `sources` y `destinations` son índices sobre esa lista.
    const points = [...sources, destination].map((p) => this.coord(p)).join(';');
    const sourceIdx = sources.map((_, i) => i).join(';');
    const destIdx = String(sources.length);

    const url =
      `${this.baseUrl}/table/v1/driving/${points}` +
      `?sources=${sourceIdx}&destinations=${destIdx}&annotations=duration`;

    const res = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) throw new RoutingError(`OSRM /table devolvió ${res.status}`);

    const body = (await res.json()) as {
      code?: string;
      durations?: Array<Array<number | null>>;
    };
    if (body.code !== 'Ok') throw new RoutingError(`OSRM /table: code=${body.code ?? 'ausente'}`);

    const rows = body.durations;
    if (!rows || rows.length !== sources.length) {
      throw new RoutingError(
        `OSRM /table devolvió ${rows?.length ?? 0} filas para ${sources.length} orígenes`,
      );
    }

    const durationsSeconds = rows.map((row) => {
      const value = row[0];
      return typeof value === 'number' ? Math.round(value) : null;
    });
    return { provider: 'osrm', durationsSeconds };
  }
}

/**
 * Mapbox Directions. Se activa cuando hay token.
 *
 * OJO con el costo: las llamadas escalan con los INTENTOS de dispatch, no con
 * los viajes cerrados. Hay que cachear por celda de grilla y minuto o la
 * factura sorprende.
 */
export class MapboxRoutingProvider implements RoutingProvider {
  constructor(private readonly token: string) {}

  async route(origin: LatLng, destination: LatLng): Promise<RouteResult> {
    const coords = `${origin.lng},${origin.lat};${destination.lng},${destination.lat}`;
    const url =
      `https://api.mapbox.com/directions/v5/mapbox/driving-traffic/${coords}` +
      `?geometries=polyline6&overview=simplified&steps=true&access_token=${this.token}`;

    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new RoutingError(`Mapbox devolvió ${res.status}`);

    const body = (await res.json()) as {
      routes?: Array<{
        distance: number;
        duration: number;
        geometry?: string;
        legs?: Array<{ steps?: OsrmStep[] }>;
      }>;
    };
    const route = body.routes?.[0];
    if (!route) throw new RoutingError('Mapbox no devolvió ninguna ruta');

    return {
      distanceMeters: Math.round(route.distance),
      durationSeconds: Math.round(route.duration),
      provider: 'mapbox',
      polyline: route.geometry ?? null,
      // Mapbox Directions desciende de OSRM y comparte la forma de los pasos,
      // así que el mismo normalizador sirve para los dos.
      steps: normalizeSteps(route.legs ?? []),
    };
  }

  async matrix(sources: readonly LatLng[], destination: LatLng): Promise<MatrixResult> {
    if (sources.length === 0) return { provider: 'mapbox', durationsSeconds: [] };

    const coords = [...sources, destination].map((p) => `${p.lng},${p.lat}`).join(';');
    const sourceIdx = sources.map((_, i) => i).join(';');
    const url =
      `https://api.mapbox.com/directions-matrix/v1/mapbox/driving/${coords}` +
      `?sources=${sourceIdx}&destinations=${sources.length}&annotations=duration` +
      `&access_token=${this.token}`;

    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new RoutingError(`Mapbox matrix devolvió ${res.status}`);

    const body = (await res.json()) as { durations?: Array<Array<number | null>> };
    const rows = body.durations;
    if (!rows || rows.length !== sources.length) {
      throw new RoutingError('Mapbox matrix devolvió una forma inesperada');
    }
    return {
      provider: 'mapbox',
      durationsSeconds: rows.map((row) => {
        const v = row[0];
        return typeof v === 'number' ? Math.round(v) : null;
      }),
    };
  }
}

/**
 * Cae a la estimación si el proveedor real falla.
 *
 * Un viaje no se puede caer porque el servicio de mapas tuvo un timeout. La
 * degradación es visible: el `provider` de la respuesta pasa a 'estimate' y eso
 * viaja hasta la app, así que nadie confunde un ETA estimado con uno real.
 */
export class ResilientRoutingProvider implements RoutingProvider {
  constructor(
    private readonly primary: RoutingProvider,
    private readonly fallback: RoutingProvider,
    private readonly onFallback?: (err: unknown) => void,
  ) {}

  async route(origin: LatLng, destination: LatLng): Promise<RouteResult> {
    try {
      return await this.primary.route(origin, destination);
    } catch (err) {
      this.onFallback?.(err);
      return this.fallback.route(origin, destination);
    }
  }

  async matrix(sources: readonly LatLng[], destination: LatLng): Promise<MatrixResult> {
    try {
      return await this.primary.matrix(sources, destination);
    } catch (err) {
      this.onFallback?.(err);
      return this.fallback.matrix(sources, destination);
    }
  }
}

export interface RoutingOptions {
  readonly osrmUrl?: string | undefined;
  readonly mapboxToken?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly onFallback?: ((err: unknown) => void) | undefined;
}

/**
 * Elige el proveedor. Prioridad: OSRM → Mapbox → estimación local.
 *
 * OSRM va primero porque es gratis, sin cuota y corre en la red local: para la
 * matriz del dispatch, que es la llamada que más se repite, no hay competencia.
 */
export function buildRoutingProvider(options: RoutingOptions = {}): RoutingProvider {
  const estimate = new EstimateRoutingProvider();
  const timeout = options.timeoutMs ?? 3500;

  if (options.osrmUrl) {
    return new ResilientRoutingProvider(
      new OsrmRoutingProvider(options.osrmUrl, timeout),
      estimate,
      options.onFallback,
    );
  }
  if (options.mapboxToken) {
    return new ResilientRoutingProvider(
      new MapboxRoutingProvider(options.mapboxToken),
      estimate,
      options.onFallback,
    );
  }
  return estimate;
}

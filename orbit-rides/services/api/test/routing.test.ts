import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  EstimateRoutingProvider, OsrmRoutingProvider, ResilientRoutingProvider,
  buildRoutingProvider, RoutingError, type RoutingProvider,
} from '../src/lib/routing.js';

const POCITOS = { lat: -34.9112, lng: -56.1553 };
const CIUDAD_VIEJA = { lat: -34.9066, lng: -56.2044 };
const BUCEO = { lat: -34.9018, lng: -56.1330 };

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Reemplaza fetch y devuelve las URLs pedidas, para poder inspeccionarlas. */
function stubFetch(response: unknown, status = 200): { urls: string[] } {
  const urls: string[] = [];
  vi.stubGlobal('fetch', async (input: string | URL) => {
    urls.push(String(input));
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => response,
    } as Response;
  });
  return { urls };
}

describe('estimación local de ruta', () => {
  it('aplica sinuosidad: la calle es más larga que la línea recta', async () => {
    const r = await new EstimateRoutingProvider().route(POCITOS, CIUDAD_VIEJA);
    expect(r.provider).toBe('estimate');
    expect(r.distanceMeters).toBeGreaterThan(5600);
    expect(r.distanceMeters).toBeLessThan(6100);
  });

  it('nunca devuelve una duración menor a 60 s', async () => {
    const r = await new EstimateRoutingProvider().route(POCITOS, POCITOS);
    expect(r.durationSeconds).toBe(60);
  });

  it('marca el proveedor, así un ETA estimado no se confunde con uno real', async () => {
    const r = await new EstimateRoutingProvider().route(POCITOS, CIUDAD_VIEJA);
    expect(r.provider).not.toBe('osrm');
    expect(r.provider).not.toBe('mapbox');
  });

  it('la matriz devuelve un valor por origen, en orden', async () => {
    const m = await new EstimateRoutingProvider().matrix([POCITOS, BUCEO], CIUDAD_VIEJA);
    expect(m.durationsSeconds).toHaveLength(2);
    expect(m.provider).toBe('estimate');
    // Pocitos está más cerca de Ciudad Vieja que Buceo.
    expect(m.durationsSeconds[0]).toBeLessThan(m.durationsSeconds[1] as number);
  });

  it('la matriz vacía no explota', async () => {
    const m = await new EstimateRoutingProvider().matrix([], CIUDAD_VIEJA);
    expect(m.durationsSeconds).toEqual([]);
  });
});

describe('OSRM', () => {
  it('parsea una ruta', async () => {
    stubFetch({ code: 'Ok', routes: [{ distance: 5912.4, duration: 843.7, geometry: 'abc123' }] });
    const r = await new OsrmRoutingProvider('http://osrm:5000').route(POCITOS, CIUDAD_VIEJA);
    expect(r.provider).toBe('osrm');
    expect(r.distanceMeters).toBe(5912);
    expect(r.durationSeconds).toBe(844);
    expect(r.polyline).toBe('abc123');
  });

  /**
   * Esta es LA trampa de OSRM: espera lon,lat, al revés de como se lee y se
   * escribe normalmente. Invertirlo no da ningún error — devuelve rutas en el
   * Atlántico con distancias plausibles. Un bug así es casi invisible.
   */
  it('manda las coordenadas como lon,lat y no al revés', async () => {
    const { urls } = stubFetch({ code: 'Ok', routes: [{ distance: 1, duration: 1 }] });
    await new OsrmRoutingProvider('http://osrm:5000').route(POCITOS, CIUDAD_VIEJA);
    expect(urls[0]).toContain('-56.1553,-34.9112;-56.2044,-34.9066');
    // Y explícitamente NO en el orden lat,lng:
    expect(urls[0]).not.toContain('-34.9112,-56.1553');
  });

  it('construye la matriz con el destino al final y los índices correctos', async () => {
    const { urls } = stubFetch({ code: 'Ok', durations: [[300], [540]] });
    const m = await new OsrmRoutingProvider('http://osrm:5000').matrix([POCITOS, BUCEO], CIUDAD_VIEJA);
    expect(m.durationsSeconds).toEqual([300, 540]);
    // Dos orígenes (índices 0 y 1) y el destino en el índice 2.
    expect(urls[0]).toContain('sources=0;1');
    expect(urls[0]).toContain('destinations=2');
    expect(urls[0]).toContain('annotations=duration');
  });

  it('un destino inalcanzable viene como null, no como 0', async () => {
    stubFetch({ code: 'Ok', durations: [[300], [null]] });
    const m = await new OsrmRoutingProvider('http://osrm:5000').matrix([POCITOS, BUCEO], CIUDAD_VIEJA);
    expect(m.durationsSeconds).toEqual([300, null]);
  });

  it('rechaza una respuesta con code distinto de Ok', async () => {
    stubFetch({ code: 'NoRoute', routes: [] });
    await expect(new OsrmRoutingProvider('http://osrm:5000').route(POCITOS, CIUDAD_VIEJA))
      .rejects.toThrow(RoutingError);
  });

  it('rechaza un HTTP de error', async () => {
    stubFetch({}, 503);
    await expect(new OsrmRoutingProvider('http://osrm:5000').route(POCITOS, CIUDAD_VIEJA))
      .rejects.toThrow(/503/);
  });

  it('rechaza una matriz con menos filas que orígenes', async () => {
    stubFetch({ code: 'Ok', durations: [[300]] });
    await expect(new OsrmRoutingProvider('http://osrm:5000').matrix([POCITOS, BUCEO], CIUDAD_VIEJA))
      .rejects.toThrow(/1 filas para 2/);
  });

  it('la matriz vacía no llama a la red', async () => {
    const { urls } = stubFetch({ code: 'Ok', durations: [] });
    const m = await new OsrmRoutingProvider('http://osrm:5000').matrix([], CIUDAD_VIEJA);
    expect(m.durationsSeconds).toEqual([]);
    expect(urls).toHaveLength(0);
  });
});

describe('resiliencia del proveedor', () => {
  it('si el primario falla usa el fallback y avisa', async () => {
    const failing: RoutingProvider = {
      route: async () => { throw new RoutingError('timeout de OSRM'); },
      matrix: async () => { throw new RoutingError('timeout de OSRM'); },
    };
    let notified: unknown = null;
    const provider = new ResilientRoutingProvider(
      failing, new EstimateRoutingProvider(), (err) => { notified = err; },
    );
    const r = await provider.route(POCITOS, CIUDAD_VIEJA);
    expect(r.provider).toBe('estimate');
    expect((notified as Error).message).toMatch(/OSRM/);
  });

  it('el fallback también cubre la matriz, que es la del dispatch', async () => {
    const failing: RoutingProvider = {
      route: async () => { throw new RoutingError('caído'); },
      matrix: async () => { throw new RoutingError('caído'); },
    };
    const provider = new ResilientRoutingProvider(failing, new EstimateRoutingProvider());
    const m = await provider.matrix([POCITOS, BUCEO], CIUDAD_VIEJA);
    expect(m.provider).toBe('estimate');
    expect(m.durationsSeconds).toHaveLength(2);
  });

  it('si el primario responde, no usa el fallback', async () => {
    const primary: RoutingProvider = {
      route: async () => ({ distanceMeters: 1234, durationSeconds: 321, provider: 'osrm', polyline: 'x' }),
      matrix: async () => ({ provider: 'osrm', durationsSeconds: [10] }),
    };
    const provider = new ResilientRoutingProvider(primary, new EstimateRoutingProvider());
    expect((await provider.route(POCITOS, CIUDAD_VIEJA)).distanceMeters).toBe(1234);
  });
});

describe('elección de proveedor', () => {
  it('sin configuración usa la estimación local', async () => {
    const p = buildRoutingProvider({});
    expect((await p.route(POCITOS, CIUDAD_VIEJA)).provider).toBe('estimate');
  });

  it('OSRM gana sobre Mapbox cuando están los dos', async () => {
    stubFetch({ code: 'Ok', routes: [{ distance: 100, duration: 100 }] });
    const p = buildRoutingProvider({ osrmUrl: 'http://osrm:5000', mapboxToken: 'pk.test' });
    expect((await p.route(POCITOS, CIUDAD_VIEJA)).provider).toBe('osrm');
  });

  it('con solo Mapbox usa Mapbox', async () => {
    stubFetch({ routes: [{ distance: 100, duration: 100 }] });
    const p = buildRoutingProvider({ mapboxToken: 'pk.test' });
    expect((await p.route(POCITOS, CIUDAD_VIEJA)).provider).toBe('mapbox');
  });
});

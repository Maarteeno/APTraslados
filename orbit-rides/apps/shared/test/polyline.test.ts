import { describe, it, expect } from 'vitest';
import { decodePolyline } from '../src/polyline';

describe('decodePolyline', () => {
  it('decodifica el ejemplo canónico del formato, con precisión 5', () => {
    // Caso de referencia de la especificación de Google:
    // (38.5, -120.2) (40.7, -120.95) (43.252, -126.453)
    const points = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@', 5);
    expect(points).toHaveLength(3);
    expect(points[0]?.lat).toBeCloseTo(38.5, 5);
    expect(points[0]?.lng).toBeCloseTo(-120.2, 5);
    expect(points[2]?.lat).toBeCloseTo(43.252, 5);
    expect(points[2]?.lng).toBeCloseTo(-126.453, 5);
  });

  it('con el factor equivocado el trazado aterriza en otro continente', () => {
    // Este test documenta el modo de fallo, no un comportamiento deseado.
    //
    // Decodificar polyline5 como si fuera polyline6 no lanza ningún error: da
    // coordenadas diez veces más chicas. Un recorrido en California aparece en
    // el golfo de Guinea, el mapa se aleja para encuadrarlo y el bug parece de
    // la cámara. Dejarlo escrito es más barato que volver a diagnosticarlo.
    const bien = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@', 5);
    const mal = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@', 6);
    expect(mal[0]?.lat).toBeCloseTo((bien[0] as { lat: number }).lat / 10, 6);
    expect(Math.abs(mal[0]?.lng ?? 0)).toBeLessThan(Math.abs(bien[0]?.lng ?? 0));
  });

  it('usa precisión 6 por defecto, que es la que pide el API a OSRM', () => {
    const conDefault = decodePolyline('_p~iF~ps|U');
    const explicito = decodePolyline('_p~iF~ps|U', 6);
    expect(conDefault).toEqual(explicito);
  });

  it('los deltas son acumulativos: cada punto se mide contra el anterior', () => {
    const points = decodePolyline('_p~iF~ps|U_ulLnnqC', 5);
    // El segundo punto está al noreste del primero en latitud y al oeste en
    // longitud. Si el acumulado estuviera mal, el segundo saldría en el delta
    // crudo, cerca de (2.2, -0.75), y no cerca de (40.7, -120.95).
    expect(points[1]?.lat).toBeCloseTo(40.7, 5);
    expect(points[1]?.lng).toBeCloseTo(-120.95, 5);
  });

  it('devuelve vacío ante entradas ausentes, sin lanzar', () => {
    // Los trazados son opcionales en toda la API: la estimación local no
    // produce geometría. Que el llamador tenga que defenderse de un null en
    // cada pantalla no aporta nada.
    expect(decodePolyline(null)).toEqual([]);
    expect(decodePolyline(undefined)).toEqual([]);
    expect(decodePolyline('')).toEqual([]);
  });

  it('no explota ni inventa puntos con una cadena corrupta', () => {
    const points = decodePolyline('esto-no-es-una-polilinea-valida', 6);
    // No importa cuántos salgan; importa que ninguno esté fuera del planeta,
    // porque un solo punto imposible hace que fitBounds encuadre medio mundo.
    for (const p of points) {
      expect(Math.abs(p.lat)).toBeLessThanOrEqual(90);
      expect(Math.abs(p.lng)).toBeLessThanOrEqual(180);
    }
  });

  it('un trazado de Montevideo en polyline6 cae dentro de la ciudad', () => {
    // Seis puntos de Ciudad Vieja a Parque Rodó, codificados en polyline6.
    // Este es el caso que importa: con precisión 5 estas mismas coordenadas
    // caerían cerca de (-3.49, -5.62), en el Atlántico frente a África.
    const points = decodePolyline('n}oqaA~emejBv|A_gEfbCg|JnhCwsMfbComM~tC_{T');

    expect(points).toHaveLength(6);
    expect(points[0]?.lat).toBeCloseTo(-34.9066, 5);
    expect(points[0]?.lng).toBeCloseTo(-56.2044, 5);
    expect(points[5]?.lat).toBeCloseTo(-34.9169, 5);
    expect(points[5]?.lng).toBeCloseTo(-56.1690, 5);

    for (const p of points) {
      expect(p.lat).toBeGreaterThan(-35.1);
      expect(p.lat).toBeLessThan(-34.7);
      expect(p.lng).toBeGreaterThan(-56.4);
      expect(p.lng).toBeLessThan(-56.0);
    }
  });
});

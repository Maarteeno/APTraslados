/** Geometría en la esfera. Sin dependencias. */

export interface LatLng {
  readonly lat: number;
  readonly lng: number;
}

export class GeoError extends Error {}

const EARTH_RADIUS_M = 6_371_008.8;

export function assertLatLng(p: LatLng, label = 'punto'): LatLng {
  if (!Number.isFinite(p.lat) || p.lat < -90 || p.lat > 90) {
    throw new GeoError(`${label}: latitud inválida ${p.lat}`);
  }
  if (!Number.isFinite(p.lng) || p.lng < -180 || p.lng > 180) {
    throw new GeoError(`${label}: longitud inválida ${p.lng}`);
  }
  return p;
}

const rad = (deg: number): number => (deg * Math.PI) / 180;
const deg = (r: number): number => (r * 180) / Math.PI;

/**
 * Distancia en línea recta, en metros.
 *
 * OJO: sirve para filtrar candidatos por radio, NO para calcular ETA ni
 * tarifa. En Montevideo la rambla y las diagonales hacen que la recta
 * mienta por minutos. El ETA sale del proveedor de ruteo.
 */
export function haversineMeters(a: LatLng, b: LatLng): number {
  assertLatLng(a, 'a');
  assertLatLng(b, 'b');
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Rumbo inicial de a hacia b, en grados [0,360). Se usa para orientar el ícono del auto. */
export function bearingDegrees(a: LatLng, b: LatLng): number {
  assertLatLng(a, 'a');
  assertLatLng(b, 'b');
  const dLng = rad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(rad(b.lat));
  const x =
    Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
    Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(dLng);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

/** Interpolación lineal entre dos puntos. Suaviza el movimiento del marcador entre pings. */
export function interpolate(a: LatLng, b: LatLng, t: number): LatLng {
  assertLatLng(a, 'a');
  assertLatLng(b, 'b');
  const c = Math.min(1, Math.max(0, t));
  return { lat: a.lat + (b.lat - a.lat) * c, lng: a.lng + (b.lng - a.lng) * c };
}

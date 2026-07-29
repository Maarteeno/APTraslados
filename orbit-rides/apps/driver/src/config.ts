/**
 * Configuración de la app de conductor.
 *
 * Las variables EXPO_PUBLIC_ se inyectan en el bundle y son PÚBLICAS: cualquiera
 * que descompile el APK las ve. Nunca poner un secreto acá.
 */

const DEFAULT_API = 'http://10.0.2.2:8080';
const DEFAULT_STYLE = 'https://tiles.openfreemap.org/styles/liberty';

function required(value: string | undefined, fallback: string, name: string): string {
  if (value && value.length > 0) return value;
  console.warn(`[config] ${name} no está definida, se usa ${fallback}`);
  return fallback;
}

export const config = {
  apiUrl: required(process.env['EXPO_PUBLIC_API_URL'], DEFAULT_API, 'EXPO_PUBLIC_API_URL'),
  mapStyleUrl: required(process.env['EXPO_PUBLIC_MAP_STYLE_URL'], DEFAULT_STYLE, 'EXPO_PUBLIC_MAP_STYLE_URL'),
} as const;

export const MONTEVIDEO = { lat: -34.9112, lng: -56.1553 } as const;

/**
 * Cada cuánto reportar la posición mientras está online.
 *
 * El backend expira la posición en Redis a los 30 s: si el conductor deja de
 * reportar, se cae solo del índice y deja de recibir ofertas. Reportar cada 8 s
 * deja margen para dos fallos consecutivos antes de desaparecer del mapa.
 */
export const POSITION_INTERVAL_MS = 8_000;

/** Teléfonos de conductor que crea el seed del backend. */
export const SEED_DRIVERS = [
  { phone: '+59899774019', label: 'Adrián Pereda', plan: 'Pro · 2 %' },
  { phone: '+59899100002', label: 'Marcela Giles', plan: 'Free · 12 %' },
  { phone: '+59899100003', label: 'Rodrigo Ferrer', plan: 'Free · 12 %' },
] as const;

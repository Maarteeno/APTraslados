/**
 * Configuración de la app.
 *
 * Las variables con prefijo EXPO_PUBLIC_ se inyectan en el bundle. Eso significa
 * que son PÚBLICAS: cualquiera que descompile el APK las ve. Está bien para una
 * URL de API o un estilo de mapa; nunca poner un secreto acá.
 */

const DEFAULT_API = 'http://10.0.2.2:8080';
const DEFAULT_STYLE = 'https://tiles.openfreemap.org/styles/liberty';

function required(value: string | undefined, fallback: string, name: string): string {
  if (value && value.length > 0) return value;
  // No se lanza: una app que no arranca porque falta una variable de entorno es
  // peor que una que arranca con el default y lo dice en la consola.
  console.warn(`[config] ${name} no está definida, se usa ${fallback}`);
  return fallback;
}

export const config = {
  apiUrl: required(process.env['EXPO_PUBLIC_API_URL'], DEFAULT_API, 'EXPO_PUBLIC_API_URL'),
  mapStyleUrl: required(process.env['EXPO_PUBLIC_MAP_STYLE_URL'], DEFAULT_STYLE, 'EXPO_PUBLIC_MAP_STYLE_URL'),
} as const;

/** Centro de Montevideo, por si el GPS todavía no respondió. */
export const MONTEVIDEO = { lat: -34.9112, lng: -56.1553 } as const;

/**
 * Destinos precargados.
 *
 * En la app real esto es un autocomplete contra un geocoder. Para la primera
 * versión, una lista fija de lugares reconocibles alcanza y evita meter una
 * dependencia más antes de que el flujo funcione.
 */
export const DESTINATIONS = [
  { name: 'Aeropuerto de Carrasco', address: 'Ruta 101, Canelones', icon: '✈', lat: -34.8384, lng: -56.0308 },
  { name: 'Terminal Tres Cruces', address: 'Bulevar Artigas 1825', icon: '🚌', lat: -34.8941, lng: -56.1663 },
  { name: 'Ciudad Vieja', address: 'Sarandí y Juan C. Gómez', icon: '🏛', lat: -34.9066, lng: -56.2044 },
  { name: 'Rambla de Pocitos', address: 'Rambla Rep. del Perú', icon: '🌊', lat: -34.9145, lng: -56.1489 },
  { name: 'Estadio Centenario', address: 'Av. Ricaldoni s/n', icon: '⚽', lat: -34.8941, lng: -56.1526 },
  { name: 'Puerto del Buceo', address: 'Rambla Armenia', icon: '⛵', lat: -34.9080, lng: -56.1330 },
  { name: 'Mercado Agrícola', address: 'José L. Terra 2220', icon: '🍅', lat: -34.8836, lng: -56.1743 },
  { name: 'Parque Rodó', address: 'Julio Herrera y Reissig', icon: '🎡', lat: -34.9169, lng: -56.1690 },
] as const;

/** Teléfonos que crea el seed del backend. Solo sirven en modo desarrollo. */
export const SEED_RIDERS = [
  { phone: '+59899100001', label: 'Gastón Delgado', role: 'pasajero' },
  { phone: '+59899100000', label: 'Admin Orbit', role: 'admin' },
] as const;

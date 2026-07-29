/** Paleta y espaciados. Un solo lugar, para que las dos apps se vean hermanas. */

export const colors = {
  bg: '#0a0e1a',
  surface: '#111726',
  surface2: '#161d30',
  line: '#232c45',
  ink: '#e8ecf7',
  dim: '#8a94ad',
  dim2: '#5b6480',
  brand: '#6c5cff',
  brand2: '#00d4ff',
  ok: '#22c55e',
  warn: '#f59e0b',
  bad: '#ef4444',
} as const;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 8, md: 12, lg: 16, xl: 24, pill: 999 } as const;

/** Formatea centavos como moneda. El backend siempre manda enteros en centavos. */
export function money(cents: number, currency = 'UYU'): string {
  const value = cents / 100;
  return `$ ${value.toLocaleString('es-UY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

export function minutes(seconds: number): string {
  const m = Math.max(1, Math.round(seconds / 60));
  return `${m} min`;
}

export function km(meters: number): string {
  return `${(meters / 1000).toFixed(1).replace('.', ',')} km`;
}

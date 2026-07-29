/**
 * Dispatch: a quién le ofrecemos el viaje y en qué orden.
 *
 * Lógica pura y determinista. El I/O (Redis, WebSocket, timers) vive en el
 * servicio; acá solo se decide. Eso lo hace testeable de verdad.
 *
 * Decisión de producto importante: ofertas EXCLUSIVAS por olas, no broadcast.
 * El broadcast es más fácil de programar y premia al que tiene el reflejo más
 * rápido mirando el celular mientras maneja. La oferta exclusiva le da 15
 * segundos tranquilos al conductor más conveniente.
 */

import { haversineMeters, type LatLng } from './geo.js';

export class DispatchError extends Error {}

export interface DriverCandidate {
  readonly driverId: string;
  readonly position: LatLng;
  readonly ratingAvg: number;
  readonly acceptanceRate: number;
  readonly cancellationRate: number;
  /** Minutos en línea sin recibir viaje. Alimenta el término de equidad. */
  readonly idleMinutes: number;
  readonly vehicleCategory: string;
  readonly onboardingApproved: boolean;
  readonly subscriptionActive: boolean;
  readonly documentsValid: boolean;
  readonly hasActiveTrip: boolean;
}

export interface DispatchConfig {
  readonly waveRadiiMeters: readonly number[];
  readonly waveSizes: readonly number[];
  readonly offerTtlSeconds: number;
  readonly requiredCategory: string;
  /** Pesos del scoring. Sumados no tienen que dar 1: son escalas independientes. */
  readonly weights: {
    readonly proximity: number;
    readonly rating: number;
    readonly acceptance: number;
    readonly fairness: number;
    readonly cancellationPenalty: number;
  };
  /** Velocidad supuesta para estimar ETA cuando no hay proveedor de ruteo. m/s */
  readonly fallbackSpeedMps: number;
}

export const DEFAULT_DISPATCH_CONFIG: DispatchConfig = {
  waveRadiiMeters: [3000, 5000, 8000],
  waveSizes: [3, 5, 5],
  offerTtlSeconds: 15,
  requiredCategory: 'standard',
  weights: { proximity: 1.0, rating: 0.35, acceptance: 0.25, fairness: 0.2, cancellationPenalty: 0.6 },
  fallbackSpeedMps: 8.5,
};

export type IneligibilityReason =
  | 'onboarding_pending'
  | 'subscription_inactive'
  | 'documents_invalid'
  | 'already_on_trip'
  | 'category_mismatch'
  | 'out_of_radius'
  | 'already_offered';

export interface EligibilityResult {
  readonly eligible: DriverCandidate[];
  readonly rejected: ReadonlyArray<{ driverId: string; reason: IneligibilityReason }>;
}

/**
 * Filtra candidatos. Devuelve también los rechazados con el motivo:
 * cuando un conductor reclama "no me llegan viajes", esto es la respuesta.
 */
export function filterEligible(
  candidates: readonly DriverCandidate[],
  origin: LatLng,
  radiusMeters: number,
  config: DispatchConfig,
  alreadyOffered: ReadonlySet<string> = new Set(),
): EligibilityResult {
  const eligible: DriverCandidate[] = [];
  const rejected: Array<{ driverId: string; reason: IneligibilityReason }> = [];

  for (const c of candidates) {
    if (!c.onboardingApproved) { rejected.push({ driverId: c.driverId, reason: 'onboarding_pending' }); continue; }
    if (!c.subscriptionActive) { rejected.push({ driverId: c.driverId, reason: 'subscription_inactive' }); continue; }
    if (!c.documentsValid)     { rejected.push({ driverId: c.driverId, reason: 'documents_invalid' }); continue; }
    if (c.hasActiveTrip)       { rejected.push({ driverId: c.driverId, reason: 'already_on_trip' }); continue; }
    if (c.vehicleCategory !== config.requiredCategory) {
      rejected.push({ driverId: c.driverId, reason: 'category_mismatch' }); continue;
    }
    if (alreadyOffered.has(c.driverId)) {
      rejected.push({ driverId: c.driverId, reason: 'already_offered' }); continue;
    }
    if (haversineMeters(c.position, origin) > radiusMeters) {
      rejected.push({ driverId: c.driverId, reason: 'out_of_radius' }); continue;
    }
    eligible.push(c);
  }
  return { eligible, rejected };
}

export interface ScoredCandidate {
  readonly candidate: DriverCandidate;
  readonly distanceMeters: number;
  readonly etaSeconds: number;
  readonly score: number;
}

/**
 * Puntaje. Más alto = mejor.
 *
 * El término de equidad (`fairness`) no es caridad: si el ranking fuera solo
 * cercanía y rating, los mismos cinco conductores se llevarían todo y el resto
 * se va en dos semanas. Perdés densidad de oferta, que es el activo real.
 */
export function scoreCandidates(
  candidates: readonly DriverCandidate[],
  origin: LatLng,
  config: DispatchConfig,
): ScoredCandidate[] {
  const w = config.weights;
  const scored = candidates.map((candidate) => {
    const distanceMeters = haversineMeters(candidate.position, origin);
    const etaSeconds = Math.max(30, Math.round(distanceMeters / config.fallbackSpeedMps));
    const proximityScore = 1 / (1 + etaSeconds / 60);
    const ratingScore = Math.max(0, (candidate.ratingAvg - 4) / 1);
    const idleScore = Math.min(1, candidate.idleMinutes / 30);
    const score =
      w.proximity * proximityScore +
      w.rating * ratingScore +
      w.acceptance * candidate.acceptanceRate +
      w.fairness * idleScore -
      w.cancellationPenalty * candidate.cancellationRate;
    return { candidate, distanceMeters, etaSeconds, score };
  });

  // Orden estable: por score desc, y ante empate por driverId para que el
  // resultado sea reproducible en los tests y en la auditoría de una disputa.
  return scored.sort((a, b) =>
    b.score !== a.score ? b.score - a.score : a.candidate.driverId.localeCompare(b.candidate.driverId),
  );
}

export interface Wave {
  readonly wave: number;
  readonly radiusMeters: number;
  readonly offers: readonly ScoredCandidate[];
  readonly expiresInSeconds: number;
}

export function assertDispatchConfig(config: DispatchConfig): DispatchConfig {
  if (config.waveRadiiMeters.length === 0) throw new DispatchError('waveRadiiMeters vacío');
  if (config.waveRadiiMeters.length !== config.waveSizes.length) {
    throw new DispatchError('waveRadiiMeters y waveSizes deben tener el mismo largo');
  }
  if (config.offerTtlSeconds <= 0) throw new DispatchError('offerTtlSeconds debe ser > 0');
  if (config.fallbackSpeedMps <= 0) throw new DispatchError('fallbackSpeedMps debe ser > 0');
  return config;
}

/**
 * Planifica UNA ola. El servicio la ejecuta, espera el TTL, y si nadie acepta
 * llama de nuevo con waveNumber + 1 y el set de ya-ofertados acumulado.
 *
 * Devuelve null cuando no quedan olas ni candidatos: eso es NO_DRIVERS.
 */
export function planWave(
  waveNumber: number,
  candidates: readonly DriverCandidate[],
  origin: LatLng,
  config: DispatchConfig,
  alreadyOffered: ReadonlySet<string> = new Set(),
): Wave | null {
  assertDispatchConfig(config);
  if (waveNumber < 1) throw new DispatchError(`waveNumber debe ser >= 1, recibí ${waveNumber}`);
  if (waveNumber > config.waveRadiiMeters.length) return null;

  const idx = waveNumber - 1;
  const radiusMeters = config.waveRadiiMeters[idx] as number;
  const size = config.waveSizes[idx] as number;

  const { eligible } = filterEligible(candidates, origin, radiusMeters, config, alreadyOffered);
  if (eligible.length === 0) return null;

  const offers = scoreCandidates(eligible, origin, config).slice(0, size);
  if (offers.length === 0) return null;

  return { wave: waveNumber, radiusMeters, offers, expiresInSeconds: config.offerTtlSeconds };
}

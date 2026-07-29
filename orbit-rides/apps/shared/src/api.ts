/**
 * Cliente del API de Orbit Rides.
 *
 * Un método por endpoint, tipado. Las dos apps lo comparten: si el contrato del
 * servidor cambia, se arregla en un solo lugar y el compilador señala los usos
 * rotos en ambas.
 */

import { HttpClient, generateId, type FetchLike } from './http';
import { MemoryTokenStorage, type TokenStorage } from './storage';
import type {
  ActiveTrip, DriverOffer, Earnings, LatLng, Me, PaymentMethod,
  Quote, Session, Settlement, Trip,
} from './types';

export interface OrbitClientOptions {
  readonly baseUrl: string;
  readonly storage?: TokenStorage;
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
  /** Se llama cuando el servidor devuelve 401. La app debería volver al login. */
  readonly onUnauthenticated?: () => void;
}

export class OrbitClient {
  readonly storage: TokenStorage;
  private readonly http: HttpClient;

  constructor(options: OrbitClientOptions) {
    this.storage = options.storage ?? new MemoryTokenStorage();
    this.http = new HttpClient({
      baseUrl: options.baseUrl,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      getToken: () => this.storage.get(),
      ...(options.onUnauthenticated ? { onUnauthenticated: options.onUnauthenticated } : {}),
    });
  }

  get baseUrl(): string {
    return this.http.url;
  }

  // ── Salud ────────────────────────────────────────────────────────────────

  async ready(): Promise<{ status: string; postgres: string; redis: string }> {
    return this.http.get('/health/ready', false);
  }

  // ── Sesión ───────────────────────────────────────────────────────────────

  /**
   * Login de desarrollo. El API firma sus propios tokens y su configuración
   * prohíbe este modo en producción; cuando exista Firebase, este método se
   * reemplaza por uno que canjee un ID token.
   */
  async devLogin(phoneE164: string): Promise<Session> {
    const session = await this.http.post<Session>('/v1/auth/dev-login', { phone: phoneE164 }, { auth: false });
    await this.storage.set(session.token);
    return session;
  }

  async me(): Promise<Me> {
    return this.http.get('/v1/me');
  }

  async logout(): Promise<void> {
    await this.storage.clear();
  }

  async hasSession(): Promise<boolean> {
    return (await this.storage.get()) !== null;
  }

  // ── Pasajero ─────────────────────────────────────────────────────────────

  async createQuote(input: {
    origin: LatLng;
    originAddress?: string | null;
    destination: LatLng;
    destinationAddress?: string | null;
  }): Promise<Quote> {
    return this.http.post<Quote>('/v1/quotes', {
      origin: input.origin,
      originAddress: input.originAddress ?? null,
      destination: input.destination,
      destinationAddress: input.destinationAddress ?? null,
    });
  }

  /**
   * Pide el viaje.
   *
   * La clave de idempotencia se deriva del `quoteId`, así un doble toque en el
   * botón —o un reintento de la red— no crea dos viajes. Una cotización solo se
   * puede consumir una vez, así que el servidor también lo impide, pero es mejor
   * no llegar a depender de eso.
   */
  async requestTrip(quoteId: string, paymentMethod: PaymentMethod): Promise<{ tripId: string; status: string }> {
    return this.http.post('/v1/trips', { quoteId, paymentMethod }, { idempotencyKey: `trip:${quoteId}` });
  }

  async getTrip(tripId: string): Promise<Trip> {
    return this.http.get(`/v1/trips/${tripId}`);
  }

  /** Viaje abierto del usuario, o null. La app lo consulta al arrancar. */
  async activeTrip(): Promise<ActiveTrip | null> {
    const res = await this.http.get<{ trip: ActiveTrip | null }>('/v1/trips/active');
    return res.trip;
  }

  async cancelTrip(tripId: string, reason?: string): Promise<{ feeCents: number; reason: string }> {
    return this.http.post(`/v1/trips/${tripId}/cancel`, { reason: reason ?? null });
  }

  // ── Conductor ────────────────────────────────────────────────────────────

  async setPosition(input: {
    position: LatLng;
    bearing?: number | null;
    isOnline: boolean;
  }): Promise<{ ok: boolean; isOnline: boolean }> {
    return this.http.post('/v1/driver/position', {
      lat: input.position.lat,
      lng: input.position.lng,
      bearing: input.bearing ?? null,
      isOnline: input.isOnline,
    });
  }

  /** Oferta vigente del conductor, o null. Respaldo por si el WebSocket se cayó. */
  async currentOffer(): Promise<DriverOffer | null> {
    const res = await this.http.get<{ offer: DriverOffer | null }>('/v1/driver/offer');
    return res.offer;
  }

  async acceptTrip(tripId: string): Promise<{ tripId: string; commissionBps: number }> {
    return this.http.post(`/v1/trips/${tripId}/accept`, undefined, { idempotencyKey: `accept:${tripId}` });
  }

  async rejectOffer(tripId: string): Promise<{ ok: boolean }> {
    return this.http.post(`/v1/trips/${tripId}/reject`);
  }

  async markArrived(tripId: string): Promise<{ ok: boolean }> {
    return this.http.post(`/v1/trips/${tripId}/arrived`, undefined, { idempotencyKey: `arrived:${tripId}` });
  }

  async startTrip(tripId: string): Promise<{ ok: boolean }> {
    return this.http.post(`/v1/trips/${tripId}/start`, undefined, { idempotencyKey: `start:${tripId}` });
  }

  async completeTrip(tripId: string, actual: {
    distanceMeters: number;
    durationSeconds: number;
  }): Promise<Settlement> {
    return this.http.post<Settlement>(
      `/v1/trips/${tripId}/complete`,
      { actualDistanceMeters: Math.round(actual.distanceMeters), actualDurationSeconds: Math.round(actual.durationSeconds) },
      { idempotencyKey: `complete:${tripId}` },
    );
  }

  async earnings(): Promise<Earnings> {
    return this.http.get('/v1/driver/earnings');
  }

  /** URL del WebSocket. El token va por query porque el WS del navegador no admite headers. */
  async socketUrl(tripId?: string): Promise<string> {
    const token = await this.storage.get();
    if (!token) throw new Error('no hay sesión para abrir el WebSocket');
    const base = this.baseUrl.replace(/^http/, 'ws');
    const params = new URLSearchParams({ token });
    if (tripId) params.set('tripId', tripId);
    return `${base}/v1/ws?${params.toString()}`;
  }
}

export { generateId };

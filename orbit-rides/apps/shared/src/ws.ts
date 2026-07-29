/**
 * WebSocket del viaje, con reconexión.
 *
 * En un celular la conexión se corta todo el tiempo: la app pasa a segundo
 * plano, el WiFi cambia a datos, el túnel se cae. Un WebSocket sin reconexión
 * automática funciona perfecto en el emulador y falla en la calle.
 *
 * Decisiones:
 *
 *  - **Backoff exponencial con jitter.** Sin jitter, si el servidor se reinicia
 *    todos los clientes reconectan en el mismo instante y lo tumban de nuevo.
 *  - **Watchdog sobre el heartbeat.** El servidor manda `ping` cada 25 s. Si
 *    pasan 45 s sin recibir nada, la conexión está muerta aunque el socket diga
 *    que está abierta: eso pasa cuando la red desaparece sin cerrar el TCP.
 *  - **El estado se expone.** La app tiene que poder mostrar "reconectando",
 *    porque un mapa congelado sin explicación es peor que un cartel.
 */

import type { SocketMessage } from './types';

export type SocketState = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface TripSocketOptions {
  /** Se resuelve en cada intento: el token puede haber cambiado. */
  readonly getUrl: () => Promise<string>;
  readonly onMessage: (message: SocketMessage) => void;
  readonly onStateChange?: (state: SocketState) => void;
  readonly onError?: (error: unknown) => void;
  readonly maxAttempts?: number;
  /** Inyectable para los tests. */
  readonly socketFactory?: (url: string) => WebSocketLike;
  readonly now?: () => number;
}

/** Lo mínimo que se usa de WebSocket, para poder testear sin uno real. */
export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

const OPEN = 1;
const HEARTBEAT_TIMEOUT_MS = 45_000;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 15_000;

export class TripSocket {
  private socket: WebSocketLike | null = null;
  private state: SocketState = 'closed';
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private lastMessageAt = 0;

  constructor(private readonly options: TripSocketOptions) {}

  get currentState(): SocketState {
    return this.state;
  }

  private setState(next: SocketState): void {
    if (this.state === next) return;
    this.state = next;
    this.options.onStateChange?.(next);
  }

  private nowMs(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** Espera antes de reintentar. Exponencial con jitter, con techo. */
  private delayFor(attempt: number): number {
    const exponential = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
    // Jitter completo: sin esto, todos los clientes reconectan a la vez.
    return Math.round(Math.random() * exponential);
  }

  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private armWatchdog(): void {
    if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
    this.watchdogTimer = setTimeout(() => {
      const silence = this.nowMs() - this.lastMessageAt;
      if (silence >= HEARTBEAT_TIMEOUT_MS) {
        // Muerta sin cerrarse. Se fuerza el cierre para disparar la reconexión.
        this.options.onError?.(new Error(`sin mensajes hace ${Math.round(silence / 1000)} s`));
        this.socket?.close(4000, 'heartbeat perdido');
      } else {
        this.armWatchdog();
      }
    }, HEARTBEAT_TIMEOUT_MS);
  }

  async connect(): Promise<void> {
    this.stopped = false;
    this.setState(this.attempts === 0 ? 'connecting' : 'reconnecting');

    let url: string;
    try {
      url = await this.options.getUrl();
    } catch (error) {
      this.options.onError?.(error);
      this.scheduleReconnect();
      return;
    }

    let socket: WebSocketLike;
    try {
      socket = this.options.socketFactory
        ? this.options.socketFactory(url)
        : (new WebSocket(url) as unknown as WebSocketLike);
    } catch (error) {
      this.options.onError?.(error);
      this.scheduleReconnect();
      return;
    }

    this.socket = socket;

    socket.onopen = () => {
      this.attempts = 0;
      this.lastMessageAt = this.nowMs();
      this.setState('open');
      this.armWatchdog();
    };

    socket.onmessage = (event) => {
      this.lastMessageAt = this.nowMs();
      if (typeof event.data !== 'string') return;
      let message: SocketMessage;
      try {
        message = JSON.parse(event.data) as SocketMessage;
      } catch {
        this.options.onError?.(new Error('mensaje ilegible por WebSocket'));
        return;
      }
      // El ping es solo señal de vida: ya actualizó lastMessageAt.
      if (message.type === 'ping') return;
      this.options.onMessage(message);
    };

    socket.onerror = (event) => {
      this.options.onError?.(event);
    };

    socket.onclose = () => {
      this.socket = null;
      this.clearTimers();
      if (this.stopped) {
        this.setState('closed');
        return;
      }
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    const max = this.options.maxAttempts ?? Infinity;
    if (this.attempts >= max) {
      this.setState('closed');
      this.options.onError?.(new Error(`se agotaron los ${max} intentos de reconexión`));
      return;
    }
    const delay = this.delayFor(this.attempts);
    this.attempts++;
    this.setState('reconnecting');
    this.reconnectTimer = setTimeout(() => {
      void this.connect();
    }, delay);
  }

  /** Cierra y deja de reintentar. */
  close(): void {
    this.stopped = true;
    this.clearTimers();
    if (this.socket && this.socket.readyState === OPEN) {
      this.socket.close(1000, 'cierre del cliente');
    }
    this.socket = null;
    this.setState('closed');
  }
}

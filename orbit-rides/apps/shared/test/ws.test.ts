import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TripSocket, type SocketState, type WebSocketLike } from '../src/ws';
import type { SocketMessage } from '../src/types';

/** WebSocket falso: expone los handlers para poder dispararlos a mano. */
class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: string[] = [];
  // `code?: number` con exactOptionalPropertyTypes no admite `undefined`
  // explícito, y close() puede llamarse sin argumentos. El tipo tiene que
  // decirlo: `number | undefined`.
  closed: Array<{ code: number | undefined; reason: string | undefined }> = [];
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;

  send(data: string): void { this.sent.push(data); }
  close(code?: number, reason?: string): void {
    this.closed.push({ code, reason });
    this.readyState = 3;
    this.onclose?.({});
  }
  open(): void { this.readyState = 1; this.onopen?.({}); }
  emit(message: unknown): void { this.onmessage?.({ data: JSON.stringify(message) }); }
  emitRaw(data: unknown): void { this.onmessage?.({ data }); }
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

interface Harness {
  socket: TripSocket;
  sockets: FakeSocket[];
  messages: SocketMessage[];
  states: SocketState[];
  errors: unknown[];
  clock: { value: number };
}

function harness(overrides: { maxAttempts?: number; getUrl?: () => Promise<string> } = {}): Harness {
  const sockets: FakeSocket[] = [];
  const messages: SocketMessage[] = [];
  const states: SocketState[] = [];
  const errors: unknown[] = [];
  const clock = { value: 1_000_000 };

  const socket = new TripSocket({
    getUrl: overrides.getUrl ?? (async () => 'ws://x/v1/ws?token=t'),
    onMessage: (m) => messages.push(m),
    onStateChange: (s) => states.push(s),
    onError: (e) => errors.push(e),
    ...(overrides.maxAttempts === undefined ? {} : { maxAttempts: overrides.maxAttempts }),
    socketFactory: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    now: () => clock.value,
  });
  return { socket, sockets, messages, states, errors, clock };
}

describe('conexión', () => {
  it('pasa a open cuando el socket abre', async () => {
    const h = harness();
    await h.socket.connect();
    h.sockets[0]?.open();
    expect(h.socket.currentState).toBe('open');
    expect(h.states).toEqual(['connecting', 'open']);
  });

  it('entrega los mensajes parseados', async () => {
    const h = harness();
    await h.socket.connect();
    h.sockets[0]?.open();
    h.sockets[0]?.emit({ type: 'trip.accepted', at: 'ahora', data: { tripId: 't1', driverId: 'd1' } });
    expect(h.messages).toHaveLength(1);
    expect(h.messages[0]?.type).toBe('trip.accepted');
  });

  it('el ping no llega a la app: es solo señal de vida', async () => {
    const h = harness();
    await h.socket.connect();
    h.sockets[0]?.open();
    h.sockets[0]?.emit({ type: 'ping', at: 'ahora', data: null });
    expect(h.messages).toHaveLength(0);
  });

  it('un mensaje ilegible avisa pero no rompe la conexión', async () => {
    const h = harness();
    await h.socket.connect();
    h.sockets[0]?.open();
    h.sockets[0]?.emitRaw('esto no es json');
    expect(h.errors).toHaveLength(1);
    expect(h.socket.currentState).toBe('open');
  });

  it('ignora datos que no son texto', async () => {
    const h = harness();
    await h.socket.connect();
    h.sockets[0]?.open();
    h.sockets[0]?.emitRaw(new ArrayBuffer(4));
    expect(h.errors).toHaveLength(0);
    expect(h.messages).toHaveLength(0);
  });
});

describe('reconexión', () => {
  it('reconecta cuando el socket se cierra solo', async () => {
    const h = harness();
    await h.socket.connect();
    h.sockets[0]?.open();
    h.sockets[0]?.close();
    expect(h.socket.currentState).toBe('reconnecting');

    await vi.advanceTimersByTimeAsync(MAX_BACKOFF);
    expect(h.sockets.length).toBeGreaterThan(1);
  });

  it('NO reconecta si la app cerró a propósito', async () => {
    const h = harness();
    await h.socket.connect();
    h.sockets[0]?.open();
    h.socket.close();

    await vi.advanceTimersByTimeAsync(MAX_BACKOFF * 3);
    expect(h.sockets).toHaveLength(1);
    expect(h.socket.currentState).toBe('closed');
  });

  it('el backoff crece y tiene techo', async () => {
    const h = harness();
    await h.socket.connect();
    // Cada cierre dispara un reintento; el techo evita esperas eternas.
    for (let i = 0; i < 8; i++) {
      h.sockets[h.sockets.length - 1]?.open();
      h.sockets[h.sockets.length - 1]?.close();
      await vi.advanceTimersByTimeAsync(MAX_BACKOFF);
    }
    // Con techo de 15 s, ocho intentos entran de sobra en el tiempo avanzado.
    expect(h.sockets.length).toBeGreaterThan(4);
  });

  /**
   * El contador de intentos se reinicia cuando la conexión ABRE. Eso es
   * deliberado: si el socket se estableció y después se cayó, es una caída
   * nueva y el backoff tiene que arrancar de cero, no seguir creciendo desde
   * la vez anterior.
   *
   * Así que para probar el límite hay que simular conexiones que NUNCA abren —
   * el caso del servidor caído. Las dos primeras versiones de este test
   * llamaban a open() antes de close() y por eso el límite no se alcanzaba
   * nunca: el código estaba bien, el test modelaba el escenario equivocado.
   */
  it('respeta el máximo de intentos cuando la conexión nunca llega a abrir', async () => {
    const h = harness({ maxAttempts: 2 });
    await h.socket.connect();

    for (let i = 0; i < 6 && h.socket.currentState !== 'closed'; i++) {
      // close() sin open(): el servidor rechaza o no responde.
      h.sockets[h.sockets.length - 1]?.close();
      await vi.advanceTimersByTimeAsync(MAX_BACKOFF);
    }

    expect(h.socket.currentState).toBe('closed');
    expect(h.errors.some((e) => String((e as Error).message).includes('intentos'))).toBe(true);
    // Intento inicial más dos reintentos.
    expect(h.sockets).toHaveLength(3);
  });

  it('una conexión exitosa reinicia el backoff: una caída nueva no arrastra la anterior', async () => {
    const h = harness({ maxAttempts: 2 });
    await h.socket.connect();

    // Dos fallos seguidos, sin llegar al límite.
    h.sockets[0]?.close();
    await vi.advanceTimersByTimeAsync(MAX_BACKOFF);

    // Ahora sí abre: el contador vuelve a cero.
    h.sockets[1]?.open();
    expect(h.socket.currentState).toBe('open');

    // Y a partir de acá vuelve a tener sus dos reintentos completos.
    h.sockets[1]?.close();
    await vi.advanceTimersByTimeAsync(MAX_BACKOFF);
    expect(h.socket.currentState).toBe('reconnecting');
    expect(h.sockets).toHaveLength(3);
  });

  it('si no puede resolver la URL reintenta en vez de morir', async () => {
    let calls = 0;
    const h = harness({
      getUrl: async () => {
        calls++;
        if (calls === 1) throw new Error('sin sesión todavía');
        return 'ws://x/v1/ws?token=t';
      },
    });
    await h.socket.connect();
    expect(h.errors).toHaveLength(1);
    expect(h.sockets).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(MAX_BACKOFF);
    expect(h.sockets).toHaveLength(1);
  });

  it('pide la URL de nuevo en cada intento: el token pudo cambiar', async () => {
    const urls: string[] = [];
    let n = 0;
    const h = harness({
      getUrl: async () => {
        n++;
        const url = `ws://x/v1/ws?token=t${n}`;
        urls.push(url);
        return url;
      },
    });
    await h.socket.connect();
    h.sockets[0]?.open();
    h.sockets[0]?.close();
    await vi.advanceTimersByTimeAsync(MAX_BACKOFF);
    expect(urls).toEqual(['ws://x/v1/ws?token=t1', 'ws://x/v1/ws?token=t2']);
  });
});

describe('watchdog del heartbeat', () => {
  /**
   * El caso que esto cubre: la red desaparece sin cerrar el TCP. El socket
   * sigue diciendo que está abierto y la app se queda con un mapa congelado sin
   * ningún error. El servidor manda ping cada 25 s; si pasan 45 s sin recibir
   * nada, la conexión está muerta.
   */
  it('fuerza el cierre si el servidor deja de mandar señales', async () => {
    const h = harness();
    await h.socket.connect();
    h.sockets[0]?.open();

    // El reloj avanza pero no llega ningún mensaje.
    h.clock.value += 60_000;
    await vi.advanceTimersByTimeAsync(46_000);

    expect(h.sockets[0]?.closed.some((c) => c.reason === 'heartbeat perdido')).toBe(true);
    expect(h.errors.some((e) => String((e as Error).message).includes('sin mensajes'))).toBe(true);
  });

  it('un ping mantiene la conexión viva', async () => {
    const h = harness();
    await h.socket.connect();
    h.sockets[0]?.open();

    // Ping a los 20 s: el reloj avanza pero llega señal.
    h.clock.value += 20_000;
    h.sockets[0]?.emit({ type: 'ping', at: 'x', data: null });
    await vi.advanceTimersByTimeAsync(46_000);

    expect(h.sockets[0]?.closed).toHaveLength(0);
    expect(h.socket.currentState).toBe('open');
  });
});

/** Techo del backoff más margen, para avanzar el reloj con holgura. */
const MAX_BACKOFF = 16_000;

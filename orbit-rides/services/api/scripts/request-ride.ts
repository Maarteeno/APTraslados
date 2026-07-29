/**
 * Simulador de pasajero, desde la terminal.
 *
 * Existe por una limitación real del emulador: MapLibre necesita un contexto
 * OpenGL por instancia, y con dos apps abiertas la GPU emulada se cae con
 * EGL_BAD_MATCH y frames de decenas de segundos. Con un solo emulador no se
 * pueden tener el pasajero y el conductor andando a la vez.
 *
 * Así que este script hace de pasajero: cotiza y pide el viaje contra el API
 * real. El conductor queda solo en el emulador, con su mapa funcionando, y la
 * oferta le llega de verdad por WebSocket.
 *
 *   npm run ride                       # pide un viaje al aeropuerto
 *   npm run ride -- centenario         # a otro destino
 *   npm run ride -- --list             # ver los destinos
 *
 * No reemplaza al smoke test: el smoke verifica el sistema completo sin
 * intervención. Esto es para mirar el dispatch con ojos humanos.
 */

const API = process.env['API_URL'] ?? 'http://localhost:8080';
const RIDER_PHONE = process.env['RIDER_PHONE'] ?? '+59899100001';

/** Origen: Pocitos. Los conductores del seed están alrededor. */
const ORIGIN = { lat: -34.9112, lng: -56.1553 };

const DESTINATIONS: Record<string, { label: string; lat: number; lng: number }> = {
  aeropuerto:  { label: 'Aeropuerto de Carrasco', lat: -34.8384, lng: -56.0308 },
  centenario:  { label: 'Estadio Centenario',     lat: -34.8941, lng: -56.1526 },
  ciudadvieja: { label: 'Ciudad Vieja',           lat: -34.9066, lng: -56.2044 },
  trescruces:  { label: 'Terminal Tres Cruces',   lat: -34.8941, lng: -56.1663 },
  buceo:       { label: 'Puerto del Buceo',       lat: -34.9080, lng: -56.1330 },
};

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', red: '\x1b[31m', cyan: '\x1b[36m', yellow: '\x1b[33m',
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Envelope { error?: { code?: string; message?: string } }

async function call<T>(method: string, path: string, token?: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  const parsed = text.length > 0 ? (JSON.parse(text) as T & Envelope) : ({} as T & Envelope);
  if (!res.ok) {
    const e = (parsed as Envelope).error;
    throw new Error(`HTTP ${res.status} ${e?.code ?? ''}: ${e?.message ?? text}`);
  }
  return parsed;
}

function money(cents: number): string {
  return `$ ${(cents / 100).toLocaleString('es-UY', { minimumFractionDigits: 2 })}`;
}

async function main(): Promise<void> {
  const arg = process.argv[2];

  if (arg === '--list' || arg === '-l') {
    console.log(`\n${C.bold}Destinos disponibles${C.reset}\n`);
    for (const [key, d] of Object.entries(DESTINATIONS)) {
      console.log(`  ${C.cyan}${key.padEnd(13)}${C.reset} ${d.label}`);
    }
    console.log(`\n${C.dim}  npm run ride -- centenario${C.reset}\n`);
    return;
  }

  const key = arg ?? 'aeropuerto';
  const destination = DESTINATIONS[key];
  if (!destination) {
    console.error(`${C.red}Destino desconocido: ${key}${C.reset}`);
    console.error(`${C.dim}Opciones: ${Object.keys(DESTINATIONS).join(', ')}${C.reset}`);
    process.exit(1);
  }

  console.log(`\n${C.bold}Pidiendo un viaje${C.reset}  ${C.dim}${API}${C.reset}`);
  console.log(`${C.dim}Pocitos → ${destination.label}${C.reset}\n`);

  // 1. Login
  const session = await call<{ token: string; user: { fullName: string } }>(
    'POST', '/v1/auth/dev-login', undefined, { phone: RIDER_PHONE },
  );
  console.log(`  ${C.green}✓${C.reset} ${session.user.fullName}`);

  // 2. Si quedó un viaje abierto, se cancela: el servidor no permite dos.
  const active = await call<{ trip: { id: string; status: string } | null }>(
    'GET', '/v1/trips/active', session.token,
  );
  if (active.trip) {
    console.log(`  ${C.yellow}!${C.reset} había un viaje ${active.trip.status}, se cancela`);
    await call('POST', `/v1/trips/${active.trip.id}/cancel`, session.token, { reason: 'nuevo pedido' });
  }

  // 3. Cotizar
  const quote = await call<{
    quoteId: string; fareCents: number; currency: string;
    distanceMeters: number; durationSeconds: number; routeProvider: string;
  }>('POST', '/v1/quotes', session.token, {
    origin: ORIGIN,
    originAddress: 'Bulevar España 2314',
    destination: { lat: destination.lat, lng: destination.lng },
    destinationAddress: destination.label,
  });
  console.log(
    `  ${C.green}✓${C.reset} ${money(quote.fareCents)} ${quote.currency} · ` +
    `${(quote.distanceMeters / 1000).toFixed(1)} km · ${Math.round(quote.durationSeconds / 60)} min ` +
    `${C.dim}(ruta: ${quote.routeProvider})${C.reset}`,
  );
  if (quote.routeProvider === 'estimate') {
    console.log(`    ${C.yellow}OSRM no respondió: es una estimación local.${C.reset}`);
    console.log(`    ${C.dim}docker compose --profile prepare up osrm-download osrm-build${C.reset}`);
  }

  // 4. Pedir
  const trip = await call<{ tripId: string }>('POST', '/v1/trips', session.token, {
    quoteId: quote.quoteId,
    paymentMethod: 'cash',
  });
  console.log(`  ${C.green}✓${C.reset} viaje ${C.bold}${trip.tripId}${C.reset}\n`);
  console.log(`${C.cyan}Mirá la app de conductor: la oferta llega en unos segundos.${C.reset}\n`);

  // 5. Seguir el estado hasta que termine
  let previous = '';
  const started = Date.now();
  const TIMEOUT_MS = 6 * 60 * 1000;

  while (Date.now() - started < TIMEOUT_MS) {
    const detail = await call<{
      status: string;
      fareCents: number | null;
      commissionBps: number | null;
      driverEarningsCents: number | null;
      currency: string;
    }>('GET', `/v1/trips/${trip.tripId}`, session.token);

    if (detail.status !== previous) {
      const seconds = Math.round((Date.now() - started) / 1000);
      const color = detail.status === 'COMPLETED' ? C.green
        : detail.status === 'CANCELED' || detail.status === 'NO_DRIVERS' ? C.red
        : C.cyan;
      console.log(`  ${C.dim}${String(seconds).padStart(3)}s${C.reset}  ${color}${detail.status}${C.reset}`);
      previous = detail.status;

      if (detail.status === 'ACCEPTED' && detail.commissionBps !== null) {
        console.log(`        ${C.dim}comisión congelada en ${(detail.commissionBps / 100).toFixed(2)} %${C.reset}`);
      }
      if (detail.status === 'COMPLETED' && detail.fareCents !== null) {
        console.log(`        ${C.dim}tarifa ${money(detail.fareCents)} · ` +
          `conductor ${money(detail.driverEarningsCents ?? 0)}${C.reset}`);
      }
      if (['COMPLETED', 'CANCELED', 'NO_DRIVERS'].includes(detail.status)) {
        console.log();
        if (detail.status === 'NO_DRIVERS') {
          console.log(`${C.yellow}No había conductores. ¿Está el switch «En línea» activado?${C.reset}\n`);
        }
        return;
      }
    }
    await sleep(1500);
  }
  console.log(`\n${C.yellow}Se cortó el seguimiento a los 6 minutos. El viaje sigue vivo.${C.reset}\n`);
}

main().catch((err: unknown) => {
  console.error(`\n${C.red}${String(err instanceof Error ? err.message : err)}${C.reset}`);
  if (String(err).includes('fetch failed') || String(err).includes('ECONNREFUSED')) {
    console.error(`${C.yellow}El API no responde en ${API}. Levantalo con: docker compose up -d${C.reset}`);
  }
  console.error();
  process.exit(1);
});

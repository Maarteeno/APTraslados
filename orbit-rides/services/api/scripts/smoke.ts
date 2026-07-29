/**
 * Prueba de humo end-to-end contra un API que ya está corriendo.
 *
 *   npm run smoke                        # http://localhost:8080
 *   API_URL=http://otra:8080 npm run smoke
 *
 * Recorre el flujo completo: login, conductores online, cotización, pedido,
 * dispatch, aceptación, viaje y liquidación. Al final verifica la integridad
 * del ledger. Cada paso imprime PASS o FALLA y el proceso termina en 1 si algo
 * salió mal, así se puede usar en CI.
 *
 * No usa dependencias: solo fetch de Node 22.
 */

const API = process.env['API_URL'] ?? 'http://localhost:8080';

const PHONES = {
  rider: '+59899100001',
  admin: '+59899100000',
  drivers: ['+59899774019', '+59899100002', '+59899100003'],
} as const;

// Pocitos → Ciudad Vieja. Los conductores del seed están alrededor del origen.
const ORIGIN = { lat: -34.9112, lng: -56.1553 };
const DESTINATION = { lat: -34.9066, lng: -56.2044 };

// ── salida ───────────────────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};
let failures = 0;
let stepNumber = 0;

function step(title: string): void {
  stepNumber++;
  process.stdout.write(`\n${C.bold}${C.cyan}${stepNumber}. ${title}${C.reset}\n`);
}
function pass(msg: string): void {
  process.stdout.write(`   ${C.green}PASS${C.reset}  ${msg}\n`);
}
function fail(msg: string): void {
  failures++;
  process.stdout.write(`   ${C.red}FALLA${C.reset} ${msg}\n`);
}
function info(msg: string): void {
  process.stdout.write(`   ${C.dim}${msg}${C.reset}\n`);
}
function check(condition: boolean, ok: string, bad: string): boolean {
  if (condition) { pass(ok); return true; }
  fail(bad);
  return false;
}

// ── cliente HTTP ─────────────────────────────────────────────────────────────
interface ApiError { error?: { code?: string; message?: string; details?: unknown } }

async function call<T>(
  method: string, path: string, token?: string, body?: unknown,
): Promise<{ status: number; body: T & ApiError }> {
  const headers: Record<string, string> = {};
  // Content-Type solo si hay body. Declarar JSON y no mandar nada es
  // contradictorio, y un servidor estricto tiene razón en rechazarlo.
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  let parsed: unknown = {};
  if (text.length > 0) {
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  }
  return { status: res.status, body: parsed as T & ApiError };
}

function describeError(status: number, body: ApiError): string {
  const code = body.error?.code ?? 'sin_codigo';
  const message = body.error?.message ?? JSON.stringify(body);
  const details = body.error?.details ? ` ${JSON.stringify(body.error.details)}` : '';
  return `HTTP ${status} ${code}: ${message}${details}`;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── pasos ────────────────────────────────────────────────────────────────────

async function waitForApi(): Promise<boolean> {
  step('Esperando que el API esté listo');
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      const { status, body } = await call<{ postgres?: string; redis?: string }>('GET', '/health/ready');
      if (status === 200) {
        pass(`postgres=${body.postgres} redis=${body.redis}`);
        return true;
      }
      info(`intento ${attempt}/30 — ${describeError(status, body)}`);
    } catch {
      info(`intento ${attempt}/30 — todavía no responde`);
    }
    await sleep(1000);
  }
  fail(`el API no respondió en ${API}. ¿Corriste "docker compose up -d"?`);
  return false;
}

async function login(phone: string, label: string): Promise<string | null> {
  const { status, body } = await call<{ token: string; user: { role: string; fullName: string } }>(
    'POST', '/v1/auth/dev-login', undefined, { phone },
  );
  if (status !== 200 || !body.token) {
    fail(`${label}: ${describeError(status, body)}`);
    if (status === 404) info('→ falta correr el seed: docker compose exec api node services/api/dist/scripts/seed.js');
    return null;
  }
  pass(`${label} → ${body.user.fullName} (${body.user.role})`);
  return body.token;
}

/**
 * Cierra un viaje que quedó abierto de una corrida anterior.
 *
 * Antes esto llamaba a /cancel y NO miraba la respuesta: imprimía «se cancela»
 * pasara lo que pasara. El problema apareció al probar a mano en el emulador y
 * dejar viajes en IN_PROGRESS: **un viaje en curso no se puede cancelar** —es
 * una regla del dominio, con su test— así que el cancel devolvía 409, la
 * limpieza lo tragaba, y el smoke moría cinco pasos después con «ya tenés un
 * viaje en curso», que no señala la causa en absoluto.
 *
 * Ahora cada estado se cierra como corresponde y el resultado se verifica.
 *
 * `asDriver` importa porque completar un viaje es una acción del CONDUCTOR: el
 * pasajero no puede, y con su token el intento devolvería 403.
 */
async function cleanupActiveTrip(token: string, label: string, asDriver = false): Promise<void> {
  const { status, body } = await call<{ trip: { id: string; status: string } | null }>(
    'GET', '/v1/trips/active', token,
  );
  if (status !== 200) { info(`${label}: no se pudo consultar viaje activo (${status})`); return; }
  if (!body.trip) { info(`${label}: sin viajes abiertos`); return; }

  const trip = body.trip;
  const inProgress = trip.status === 'IN_PROGRESS';

  if (inProgress && !asDriver) {
    // El pasajero no puede cerrar un viaje en curso. No es un fallo: lo va a
    // cerrar el conductor cuando le toque su turno de limpieza.
    info(`${label}: viaje ${trip.status}, lo cierra el conductor`);
    return;
  }

  const result = inProgress
    ? await call('POST', `/v1/trips/${trip.id}/complete`, token, {
        actualDistanceMeters: 1000, actualDurationSeconds: 300,
      })
    : await call('POST', `/v1/trips/${trip.id}/cancel`, token, { reason: 'limpieza de smoke test' });

  if (result.status === 200) {
    info(`${label}: se cerró un viaje ${trip.status} de una corrida anterior`);
  } else {
    fail(`${label}: no se pudo cerrar el viaje ${trip.status} — ${describeError(result.status, result.body)}`);
    info('el smoke va a fallar más adelante con "ya tenés un viaje en curso"; la causa es esta');
  }
}

async function main(): Promise<void> {
  process.stdout.write(`${C.bold}Orbit Rides — prueba de humo${C.reset}\n${C.dim}${API}${C.reset}\n`);

  if (!(await waitForApi())) process.exit(1);

  // ── 2. Logins
  step('Login de todos los usuarios (modo dev)');
  const riderToken = await login(PHONES.rider, 'pasajero');
  const adminToken = await login(PHONES.admin, 'admin');
  const driverTokens: string[] = [];
  for (const [i, phone] of PHONES.drivers.entries()) {
    const t = await login(phone, `conductor ${i + 1}`);
    if (t) driverTokens.push(t);
  }
  if (!riderToken || !adminToken || driverTokens.length === 0) {
    fail('sin tokens no se puede seguir');
    process.exit(1);
  }

  // ── 3. Limpieza
  step('Limpiando viajes de corridas anteriores');
  // Los CONDUCTORES primero: un viaje en curso solo lo puede cerrar el
  // conductor, y hasta que se cierre el pasajero sigue con su viaje abierto.
  // Al revés, el pasajero no podría hacer nada y el smoke fallaría después.
  for (const [i, t] of driverTokens.entries()) await cleanupActiveTrip(t, `conductor ${i + 1}`, true);
  await cleanupActiveTrip(riderToken, 'pasajero');

  // Y se verifica que quedó limpio, en vez de suponerlo. Sin esto, cualquier
  // fallo de la limpieza reaparece cinco pasos después como un 409 que no dice
  // de dónde viene.
  const stillOpen = await call<{ trip: { status: string } | null }>('GET', '/v1/trips/active', riderToken);
  check(
    stillOpen.body.trip === null,
    'el pasajero quedó sin viajes abiertos',
    `PROBLEMA: al pasajero le quedó un viaje ${stillOpen.body.trip?.status}`,
  );

  // ── 4. Conductores online
  step('Poniendo conductores online');
  info('sin esto no hay a quién ofertarle y todo termina en NO_DRIVERS');
  const offsets = [[0.0023, -0.0048], [-0.0033, 0.0064], [0.0061, -0.0159]] as const;
  for (const [i, token] of driverTokens.entries()) {
    const off = offsets[i] ?? [0, 0];
    const { status, body } = await call('POST', '/v1/driver/position', token, {
      lat: ORIGIN.lat + (off[0] ?? 0),
      lng: ORIGIN.lng + (off[1] ?? 0),
      bearing: 0,
      isOnline: true,
    });
    check(status === 200, `conductor ${i + 1} online`, `conductor ${i + 1}: ${describeError(status, body)}`);
  }

  // ── 5. Cotización
  step('Pidiendo cotización');
  const quote = await call<{
    quoteId: string; fareCents: number; currency: string; distanceMeters: number;
    durationSeconds: number; routeProvider: string; expiresAt: string;
    breakdown: { baseCents: number; distanceCents: number; timeCents: number };
    routePolyline: string | null;
    routeSteps: Array<{ type: string; name: string; at: { lat: number; lng: number } }>;
  }>('POST', '/v1/quotes', riderToken, {
    origin: ORIGIN, originAddress: 'Bulevar España 2314',
    destination: DESTINATION, destinationAddress: 'Sarandí y Juan C. Gómez',
  });

  if (quote.status !== 200) {
    fail(describeError(quote.status, quote.body));
    process.exit(1);
  }
  const q = quote.body;
  pass(`$${(q.fareCents / 100).toFixed(2)} ${q.currency} · ${(q.distanceMeters / 1000).toFixed(1)} km · ${Math.round(q.durationSeconds / 60)} min`);
  info(`desglose: base ${q.breakdown.baseCents / 100} + distancia ${q.breakdown.distanceCents / 100} + tiempo ${q.breakdown.timeCents / 100}`);
  info(`proveedor de ruta: ${q.routeProvider}${q.routeProvider === 'estimate' ? ' (sin MAPBOX_TOKEN, estimación local)' : ''}`);
  check(q.fareCents > 0, 'la tarifa es positiva', 'la tarifa dio 0 o negativa');

  // La geometría solo existe con un proveedor real. Con la estimación local no
  // hay trazado y eso es correcto, así que la comprobación se condiciona.
  if (q.routeProvider === 'estimate') {
    info('sin proveedor real no hay trazado: las apps van a dibujar la recta');
  } else {
    check(
      typeof q.routePolyline === 'string' && q.routePolyline.length > 20,
      `la cotización trae el trazado (${q.routePolyline?.length ?? 0} caracteres)`,
      'PROBLEMA: ruta real sin trazado, las apps dibujarían una recta',
    );
    // Las maniobras son lo que alimenta el cartel de navegación. Sin ellas la
    // app dibuja la ruta pero no puede decir dónde girar.
    const steps = q.routeSteps ?? [];
    check(
      steps.length >= 2,
      `la cotización trae ${steps.length} maniobras`,
      `PROBLEMA: ruta real con ${steps.length} maniobras, el cartel quedaría mudo`,
    );
    // La última maniobra SIEMPRE es la llegada. Si no lo es, se perdió el final
    // en el camino y el conductor nunca vería «llegaste».
    check(
      steps[steps.length - 1]?.type === 'arrive',
      'la última maniobra es la llegada',
      `PROBLEMA: la última maniobra es "${steps[steps.length - 1]?.type}" y debería ser "arrive"`,
    );
    // lat/lng invertidos es el error clásico con OSRM, y no da ningún error:
    // pone las maniobras en el golfo de Guinea. Montevideo está en (-34.9, -56.2).
    const first = steps[0]?.at;
    check(
      first !== undefined && first.lat < -30 && first.lat > -40 && first.lng < -50 && first.lng > -60,
      'las maniobras caen en Uruguay (lat/lng no están invertidas)',
      `PROBLEMA: la primera maniobra cayó en ${first?.lat}, ${first?.lng}`,
    );
  }

  // ── 6. La firma protege el monto
  step('Verificando que el monto no se puede falsificar');
  const tampered = await call('POST', '/v1/trips', riderToken, {
    quoteId: '00000000-0000-4000-8000-000000000000',
    paymentMethod: 'cash',
  });
  check(
    tampered.status === 404 || tampered.status === 422,
    `una cotización inexistente se rechaza (HTTP ${tampered.status})`,
    `se aceptó una cotización falsa: HTTP ${tampered.status}`,
  );

  // ── 7. Pedir el viaje
  step('Pidiendo el viaje');
  const trip = await call<{ tripId: string; status: string }>('POST', '/v1/trips', riderToken, {
    quoteId: q.quoteId,
    paymentMethod: 'cash',
  });
  if (trip.status !== 201) {
    fail(describeError(trip.status, trip.body));
    process.exit(1);
  }
  const tripId = trip.body.tripId;
  pass(`viaje ${tripId} en estado ${trip.body.status}`);

  // ── 8. La cotización no se puede reutilizar
  step('Verificando que una cotización no se reutiliza');
  const reuse = await call('POST', '/v1/trips', riderToken, { quoteId: q.quoteId, paymentMethod: 'cash' });
  check(
    reuse.status === 409,
    'reutilizar la cotización devuelve 409',
    `se pudo reutilizar la cotización: HTTP ${reuse.status}`,
  );

  // ── 9. Esperar la oferta del dispatch
  step('Esperando que el dispatch oferte');
  let winnerIndex = -1;
  for (let attempt = 0; attempt < 40 && winnerIndex < 0; attempt++) {
    for (const [i, token] of driverTokens.entries()) {
      const { status, body } = await call<{ offer: { tripId: string } | null }>('GET', '/v1/driver/offer', token);
      if (status === 200 && body.offer?.tripId === tripId) { winnerIndex = i; break; }
    }
    if (winnerIndex < 0) await sleep(500);
  }
  if (winnerIndex < 0) {
    fail('ningún conductor recibió la oferta en 20 s');
    info('mirá los logs: docker compose logs --tail=80 api');
    const detail = await call<{ status: string }>('GET', `/v1/trips/${tripId}`, riderToken);
    info(`estado del viaje: ${detail.body.status}`);
    process.exit(1);
  }
  const driverToken = driverTokens[winnerIndex] as string;
  pass(`conductor ${winnerIndex + 1} recibió la oferta`);

  // ── 9b. El conductor ofertado puede LEER el viaje antes de aceptar
  //
  // Este paso existe por un bug que el smoke no veía: aceptaba llamando a
  // /accept directo, mientras la app primero hace GET /v1/trips/:id para
  // mostrar origen, destino y tarifa. Ese GET daba 403 porque el conductor
  // todavía no es trip.driver_id — se asigna recién al aceptar. Resultado: en
  // la app el botón Aceptar nunca se habilitaba, y los 18 pasos daban TODO OK.
  //
  // La lección: probar el flujo con las mismas llamadas que hace el cliente,
  // no con el camino más corto al mismo estado.
  step('Verificando que el conductor ofertado ve el viaje');
  const offeredDetail = await call<{
    status: string; fareCents: number | null; routePolyline: string | null;
  }>('GET', `/v1/trips/${tripId}`, driverToken);
  if (offeredDetail.status !== 200) {
    fail(describeError(offeredDetail.status, offeredDetail.body));
    info('sin esto la pantalla de oferta queda en "Cargando el viaje…" para siempre');
    process.exit(1);
  }
  pass('el conductor con oferta vigente puede leer el viaje');

  // El trazado tiene que haberse COPIADO de la cotización al viaje. Si se
  // perdiera acá, el preview de la oferta caería a la recta sin avisar.
  if (q.routeProvider !== 'estimate') {
    check(
      typeof offeredDetail.body.routePolyline === 'string',
      'el trazado se copió de la cotización al viaje',
      'PROBLEMA: el viaje quedó sin trazado pese a tener ruta real',
    );
  }

  // El recíproco NO se puede probar acá: DISPATCH_WAVE_SIZES empieza en 3 y el
  // seed crea 3 conductores, así que en la ola 1 los tres tienen oferta vigente
  // y los tres pueden leer el viaje — correctamente. Se verifica después de
  // aceptar, cuando las ofertas perdedoras quedan en 'superseded'.

  // ── 10. Aceptar
  step('Aceptando el viaje');
  const accept = await call<{ tripId: string; commissionBps: number }>(
    'POST', `/v1/trips/${tripId}/accept`, driverToken,
  );
  if (accept.status !== 200) {
    fail(describeError(accept.status, accept.body));
    process.exit(1);
  }
  pass(`aceptado · comisión CONGELADA en ${(accept.body.commissionBps / 100).toFixed(2)} %`);

  // ── 10b. Ruta de acercamiento
  //
  // Se calcula DESPUÉS de la transacción de aceptación, así que puede no estar
  // lista en el instante siguiente. Se le da margen antes de mirar.
  //
  // No falla el smoke si no aparece: es best-effort por diseño —un OSRM caído
  // no puede impedir que un conductor tome un viaje— y en esta corrida el
  // conductor se puso online con una posición fija, no con GPS real.
  step('Verificando la ruta de acercamiento al pasajero');
  await sleep(1500);
  const afterAccept = await call<{ pickupPolyline: string | null }>(
    'GET', `/v1/trips/${tripId}`, driverToken,
  );
  if (typeof afterAccept.body.pickupPolyline === 'string') {
    pass(`el conductor tiene trazado hasta el pasajero (${afterAccept.body.pickupPolyline.length} caracteres)`);
  } else {
    info('sin ruta de acercamiento: la app cae a la línea recta hasta el origen');
  }

  // ── 11. Un segundo conductor no puede robarlo
  step('Verificando que otro conductor no puede tomar el mismo viaje');
  const other = driverTokens.find((_, i) => i !== winnerIndex);
  if (other) {
    const steal = await call('POST', `/v1/trips/${tripId}/accept`, other);
    check(
      steal.status === 403 || steal.status === 409,
      `el segundo conductor recibe HTTP ${steal.status}`,
      `PROBLEMA: el segundo conductor pudo aceptar (HTTP ${steal.status})`,
    );
    // Y tampoco puede seguir LEYÉNDOLO. El permiso de lectura viene de la
    // oferta, no del rol: al aceptar uno, las demás quedan 'superseded' y el
    // acceso se apaga solo. Sin esta comprobación, la excepción que se agregó
    // en getTripDetail podría degenerar en "cualquier conductor que alguna vez
    // recibió una oferta puede espiar el viaje para siempre".
    const spy = await call<{ status?: string }>('GET', `/v1/trips/${tripId}`, other);
    check(
      spy.status === 403,
      'un conductor con oferta ya resuelta deja de ver el viaje (403)',
      `PROBLEMA: deberia recibir 403 y recibio ${spy.status}`,
    );
  } else {
    info('solo hay un conductor logueado, se saltea');
  }

  // ── 12. Transiciones inválidas
  step('Verificando que no se pueden saltear estados');
  const skip = await call('POST', `/v1/trips/${tripId}/complete`, driverToken, {
    actualDistanceMeters: 5900, actualDurationSeconds: 840,
  });
  check(
    skip.status === 409,
    'completar sin haber iniciado devuelve 409',
    `se pudo completar salteando estados: HTTP ${skip.status}`,
  );

  // ── 13. Avanzar el viaje
  step('Recorriendo el viaje');
  // El saldo se captura ANTES de liquidar, para poder medir el DELTA de este
  // viaje. Comparar el saldo acumulado contra la comisión de la semana es una
  // trampa: mezcla dos ventanas de tiempo distintas y da falsos negativos en
  // cuanto hay más de un viaje, o un payout, o un cruce de semana.
  const before = await call<{ balanceCents: number }>('GET', '/v1/driver/earnings', driverToken);
  const balanceBefore = before.status === 200 ? before.body.balanceCents : 0;
  info(`saldo del conductor antes de liquidar: $${(balanceBefore / 100).toFixed(2)}`);

  for (const [action, label] of [['arrived', 'llegó al origen'], ['start', 'pasajero a bordo']] as const) {
    const { status, body } = await call('POST', `/v1/trips/${tripId}/${action}`, driverToken);
    check(status === 200, label, `${label}: ${describeError(status, body)}`);
  }

  // ── 14. Completar y liquidar
  step('Completando y liquidando');
  const done = await call<{
    fareCents: number; commissionCents: number; driverEarningsCents: number;
    currency: string; recalculated: boolean;
  }>('POST', `/v1/trips/${tripId}/complete`, driverToken, {
    actualDistanceMeters: q.distanceMeters,
    actualDurationSeconds: q.durationSeconds,
  });
  if (done.status !== 200) {
    fail(describeError(done.status, done.body));
    process.exit(1);
  }
  const d = done.body;
  pass(`tarifa $${(d.fareCents / 100).toFixed(2)} ${d.currency}`);
  info(`comisión $${(d.commissionCents / 100).toFixed(2)} · conductor $${(d.driverEarningsCents / 100).toFixed(2)}`);
  check(
    d.commissionCents + d.driverEarningsCents === d.fareCents,
    'comisión + ganancia = tarifa exacta (no se perdió ni un centavo)',
    `descalce: ${d.commissionCents} + ${d.driverEarningsCents} != ${d.fareCents}`,
  );

  // ── 15. Bitácora
  step('Revisando la bitácora del viaje');
  const detail = await call<{
    status: string;
    events: Array<{ from: string | null; to: string; actor: string }>;
  }>('GET', `/v1/trips/${tripId}`, riderToken);
  if (detail.status !== 200) {
    fail(describeError(detail.status, detail.body));
  } else {
    const seen = detail.body.events.map((e) => e.to);
    info(`transiciones: ${seen.join(' → ')}`);
    for (const expected of ['REQUESTED', 'MATCHING', 'ACCEPTED', 'ARRIVED', 'IN_PROGRESS', 'COMPLETED']) {
      check(seen.includes(expected), `${expected} quedó registrado`, `falta el evento ${expected}`);
    }
    check(detail.body.status === 'COMPLETED', 'estado final COMPLETED', `estado final ${detail.body.status}`);
  }

  // ── 16. Ganancias del conductor
  step('Consultando ganancias del conductor');
  const earnings = await call<{
    pendingPayoutCents: number; owedToPlatformCents: number; balanceCents: number;
    thisWeek: { trips: number; grossCents: number; commissionCents: number };
  }>('GET', '/v1/driver/earnings', driverToken);
  if (earnings.status === 200) {
    const e = earnings.body;
    pass(`${e.thisWeek.trips} viaje(s) esta semana · bruto $${(e.thisWeek.grossCents / 100).toFixed(2)}`);
    info(`le debemos al conductor:  $${(e.pendingPayoutCents / 100).toFixed(2)}`);
    info(`el conductor nos debe:    $${(e.owedToPlatformCents / 100).toFixed(2)}`);
    info(`saldo contable:           $${(e.balanceCents / 100).toFixed(2)}`);

    // El viaje del smoke se paga en efectivo: el conductor cobró la tarifa
    // completa de la mano del pasajero, así que la comisión queda a cobrar.
    // Convención: driver_balance positivo = él nos debe.
    const delta = e.balanceCents - balanceBefore;
    info(`delta de ESTE viaje:      $${(delta / 100).toFixed(2)} (comisión $${(d.commissionCents / 100).toFixed(2)})`);
    check(
      delta === d.commissionCents,
      `el efectivo dejó la comisión a cobrar: el saldo subió exactamente $${(d.commissionCents / 100).toFixed(2)}`,
      `el saldo se movió ${delta} y la comisión fue ${d.commissionCents}. ` +
        (delta === -d.commissionCents
          ? 'Es exactamente el opuesto: hay una inversión de signo en el asiento.'
          : 'No coincide.'),
    );
  } else {
    fail(describeError(earnings.status, earnings.body));
  }

  // ── 17. Integridad del ledger
  step('Verificando la integridad contable');
  const ledger = await call<{ healthy: boolean; unbalancedTransactions: unknown[] }>(
    'GET', '/v1/admin/ledger/integrity', adminToken,
  );
  if (ledger.status !== 200) {
    fail(describeError(ledger.status, ledger.body));
  } else {
    check(
      ledger.body.healthy,
      'todas las transacciones del ledger suman cero',
      `HAY UN BUG DE DINERO: ${JSON.stringify(ledger.body.unbalancedTransactions)}`,
    );
  }

  // ── 18. Autorización
  step('Verificando el control de acceso');
  const noToken = await call('GET', '/v1/me');
  check(noToken.status === 401, 'sin token devuelve 401', `sin token devolvió ${noToken.status}`);

  const riderAsAdmin = await call('GET', '/v1/admin/ledger/integrity', riderToken);
  check(riderAsAdmin.status === 403, 'un pasajero no accede al panel admin (403)', `el pasajero recibió ${riderAsAdmin.status}`);

  const riderAsDriver = await call('POST', '/v1/driver/position', riderToken, {
    lat: ORIGIN.lat, lng: ORIGIN.lng, isOnline: true,
  });
  check(riderAsDriver.status === 403, 'un pasajero no reporta posición de conductor (403)', `recibió ${riderAsDriver.status}`);

  // ── Resumen
  const line = '─'.repeat(58);
  process.stdout.write(`\n${C.dim}${line}${C.reset}\n`);
  if (failures === 0) {
    process.stdout.write(`${C.green}${C.bold}  TODO OK${C.reset} — el flujo completo funciona de punta a punta\n`);
    process.stdout.write(`${C.dim}  viaje de prueba: ${tripId}${C.reset}\n`);
  } else {
    process.stdout.write(`${C.red}${C.bold}  ${failures} verificación(es) fallaron${C.reset}\n`);
  }
  process.stdout.write(`${C.dim}${line}${C.reset}\n\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stdout.write(`\n${C.red}La prueba de humo se cayó:${C.reset} ${String(err)}\n`);
  if (String(err).includes('fetch failed') || String(err).includes('ECONNREFUSED')) {
    process.stdout.write(`${C.yellow}El API no responde en ${API}. Levantalo con: docker compose up -d${C.reset}\n`);
  }
  process.exit(1);
});

# Orbit Rides — Arquitectura técnica y roadmap

**Versión:** 0.1 · 27/07/2026
**Punto de partida:** `APTraslados` 1.0.1 Beta (PWA estática, Firebase, sin backend)
**Objetivo:** marketplace de viajes con app de pasajero, suite de conductor y suite de admin, monetizado por suscripción + comisión.

---

## 1. La decisión que ordena todo lo demás

Tenés que elegir dónde vive la verdad.

Hoy vive en el navegador. Eso alcanza para un brochure. No alcanza para un marketplace, y la razón es concreta: si el cliente calcula la tarifa, el conductor edita el número. Si el cliente decide si la suscripción está vigente, el conductor la extiende gratis. Si el cliente elige a quién le llega el viaje, el conductor se autoasigna los mejores.

**Principio rector: el servidor es autoritativo sobre tarifa, comisión, asignación y dinero. El cliente solo dibuja y captura intención.**

Todo lo que sigue es consecuencia de eso.

### Principios secundarios

1. **Un servicio, no doce.** Microservicios en el día 1 con un equipo chico es suicidio operativo. Monolito modular; se parte cuando duela.
2. **Ledger de doble entrada desde el primer peso.** Reconstruir plata a posteriori es imposible. Se hace bien de entrada o no se hace.
3. **Idempotencia en todo lo que toque dinero o estado de viaje.** Las redes móviles duplican requests. Siempre.
4. **La ciudad es la unidad de configuración.** Tarifas, comisiones, planes y reglas varían por mercado. Nada hardcodeado.
5. **Nativo para pasajero y conductor.** La PWA no da ubicación en background ni push confiable en iOS. Es un límite de plataforma, no de esfuerzo.

---

## 2. Stack recomendado

| Capa | Elección | Por qué | Alternativa considerada |
|---|---|---|---|
| App pasajero | React Native (Expo, dev client) | Un equipo, dos plataformas. Expo resuelve build/OTA. Necesitás módulos nativos, así que dev client, no Expo Go. | Flutter — mejor rendimiento de mapa, peor pool de talento en la región |
| App conductor | React Native, **binario separado** | Ubicación en background, foreground service Android, pantalla siempre encendida. Comparte lógica vía monorepo, no la app. | Misma app con toggle de rol — **evitalo**, los permisos y el ciclo de vida son incompatibles |
| Suite admin | React + Vite + TanStack Query | Web, escritorio. Rápido de construir. Podés portar los patrones de UX del panel actual. | Retool — más rápido al inicio, se traba cuando querés algo propio |
| Backend | **Node 22 + TypeScript + Fastify**, monolito modular | Un solo lenguaje en todo el stack. Tipos compartidos cliente-servidor. Suficiente para 10k viajes/día. | Go — más rápido y más barato en RAM, pero duplica la base de conocimiento del equipo |
| Base de datos | **PostgreSQL 16 + PostGIS** | Transaccional para dinero, geoespacial de verdad para matching. `ST_DWithin` con índice GiST resuelve "conductores en 3 km" en milisegundos. | Firestore — no tiene queries por radio; te obliga a geohash manual y no da transacciones serias sobre dinero |
| Estado en vivo / colas | **Redis 7** | Últimas posiciones de conductores (TTL), locks de dispatch, rate limiting, colas con BullMQ. | Kafka — sobredimensionado hasta que tengas varias ciudades |
| Transporte realtime | **WebSocket** (Socket.IO o `ws` + adapter Redis) | Ubicación y estado del viaje. Un canal, control total del backpressure. | Firestore listeners — cómodo, pero pagás por lectura y la factura escala con el cuadrado del tráfico |
| Push | Firebase Cloud Messaging | Es el estándar, funciona en ambas plataformas, gratis. | — |
| Auth | Firebase Auth (teléfono/OTP + Google) | Ya lo conocés, resuelve OTP en LatAm, y el backend valida el ID token. Los datos de negocio viven en Postgres. | Auth propio — no construyas OTP a mano |
| Mapas y ruteo | **Mapbox** (tiles + Directions + Geocoding) | Precio predecible, mapas offline, buen SDK RN. Cubre Uruguay bien. | Google Maps — mejor data de tráfico, más caro y con términos más rígidos |
| Pagos | **MercadoPago** (LatAm) + Stripe (suscripciones internacionales si expandís) | MP es lo que la gente usa en la región y soporta débito local. | dLocal — bueno para cobro internacional, peor UX de checkout local |
| Infra | Contenedores en Fly.io o Railway al inicio; AWS ECS/RDS cuando duela | No armes Kubernetes para tres servicios. | — |
| Observabilidad | OpenTelemetry → Grafana Cloud o Datadog; Sentry en móvil | Trazas distribuidas desde el día 1 o vas a debuggear a ciegas. | — |

### Qué se rescata del código actual

- **El modelo de acceso por duración** (`accessUntil`, otorgar/extender, presets 24h/7d/15d/30d, countdown vivo, "vencer ahora"). Está bien diseñado y se mapea directo a la gestión de suscripciones del nuevo admin. Reusá el diseño, reescribí el código.
- **El patrón de `accessLogs`** como bitácora de accesos → se convierte en `audit_log`.
- **La disciplina de sanitizar y usar `textContent`.** Llevátela.
- **El sitio actual como landing pública** de Orbit Rides, con onboarding de conductor. Sirve tal cual, con branding nuevo.

Todo lo demás se descarta. No es desperdicio: sirvió para validar el negocio de traslados y para aprender el dominio.

---

## 3. Topología

```
┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│  App Pasajero │   │ App Conductor │   │  Admin (web)  │
│  React Native │   │  React Native │   │  React + Vite │
└───────┬───────┘   └───────┬───────┘   └───────┬───────┘
        │  REST + WS        │  REST + WS        │  REST
        └───────────────────┼───────────────────┘
                            │
                  ┌─────────▼─────────┐
                  │   API Gateway     │  Fastify
                  │  auth · rate limit│  valida ID token Firebase
                  └─────────┬─────────┘
                            │
        ┌───────────────────┼───────────────────┐
        │                   │                   │
 ┌──────▼──────┐   ┌────────▼────────┐  ┌───────▼───────┐
 │  Módulos    │   │  Dispatcher     │  │  Ledger       │
 │  de dominio │   │  worker         │  │  (doble       │
 │ users·trips │   │  BullMQ + Redis │  │   entrada)    │
 │ pricing·kyc │   └────────┬────────┘  └───────┬───────┘
 └──────┬──────┘            │                   │
        └───────────────────┼───────────────────┘
                            │
          ┌─────────────────┼─────────────────┐
          │                 │                 │
   ┌──────▼──────┐   ┌──────▼──────┐   ┌──────▼──────┐
   │ PostgreSQL  │   │   Redis     │   │  Externos   │
   │  + PostGIS  │   │ pos · locks │   │ MP · Mapbox │
   │  (verdad)   │   │ colas       │   │ FCM · Auth  │
   └─────────────┘   └─────────────┘   └─────────────┘
```

El dispatcher es un worker separado del API desde el día 1. Es el componente con el perfil de carga más distinto (picos, latencia crítica) y el que vas a querer escalar solo.

---

## 4. Modelo de datos

Esquema Postgres, resumido a lo esencial. `money` siempre `BIGINT` en centavos — nunca `FLOAT`.

```sql
-- ─── Identidad ───────────────────────────────────────────
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firebase_uid  TEXT UNIQUE NOT NULL,
  phone_e164    TEXT UNIQUE NOT NULL,
  email         TEXT,
  full_name     TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('rider','driver','admin','support')),
  status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','suspended','deleted')),
  city_id       UUID REFERENCES cities(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ           -- borrado lógico, requisito legal
);

CREATE TABLE cities (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name           TEXT NOT NULL,
  country_code   CHAR(2) NOT NULL,
  currency       CHAR(3) NOT NULL,        -- 'UYU'
  timezone       TEXT NOT NULL,
  boundary       GEOGRAPHY(POLYGON,4326) NOT NULL,
  is_live        BOOLEAN NOT NULL DEFAULT false
);

-- ─── Conductor ───────────────────────────────────────────
CREATE TABLE drivers (
  user_id            UUID PRIMARY KEY REFERENCES users(id),
  onboarding_status  TEXT NOT NULL DEFAULT 'documents_pending'
    CHECK (onboarding_status IN
      ('documents_pending','under_review','approved','rejected','suspended')),
  plan_id            UUID REFERENCES plans(id),
  rating_avg         NUMERIC(3,2),
  rating_count       INT NOT NULL DEFAULT 0,
  acceptance_rate    NUMERIC(4,3),
  cancellation_rate  NUMERIC(4,3),
  approved_at        TIMESTAMPTZ
);

CREATE TABLE driver_documents (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id    UUID NOT NULL REFERENCES drivers(user_id),
  kind         TEXT NOT NULL CHECK (kind IN
                 ('license','vehicle_registration','insurance',
                  'background_check','profile_photo','vehicle_photo')),
  storage_key  TEXT NOT NULL,           -- objeto privado, nunca URL pública
  expires_at   DATE,                    -- seguro y libreta vencen: hay que vigilarlo
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','approved','rejected')),
  reviewed_by  UUID REFERENCES users(id),
  reviewed_at  TIMESTAMPTZ,
  reject_note  TEXT
);

CREATE TABLE vehicles (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id   UUID NOT NULL REFERENCES drivers(user_id),
  plate       TEXT NOT NULL,
  make        TEXT NOT NULL,
  model       TEXT NOT NULL,
  year        INT NOT NULL,
  color       TEXT NOT NULL,
  seats       INT NOT NULL DEFAULT 4,
  category    TEXT NOT NULL DEFAULT 'standard',
  is_active   BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (plate, driver_id)
);

-- ─── Suscripciones y comisión ────────────────────────────
CREATE TABLE plans (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  city_id               UUID NOT NULL REFERENCES cities(id),
  code                  TEXT NOT NULL,      -- 'free' | 'pro' | 'plus'
  name                  TEXT NOT NULL,
  monthly_fee_cents     BIGINT NOT NULL,
  commission_bps        INT NOT NULL,       -- basis points: 1200 = 12%
  max_rides_per_month   INT,                -- NULL = ilimitado
  is_active             BOOLEAN NOT NULL DEFAULT true,
  effective_from        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (city_id, code, effective_from)
);

CREATE TABLE subscriptions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id            UUID NOT NULL REFERENCES drivers(user_id),
  plan_id              UUID NOT NULL REFERENCES plans(id),
  status               TEXT NOT NULL CHECK (status IN
                         ('trialing','active','past_due','canceled','expired')),
  current_period_start TIMESTAMPTZ NOT NULL,
  current_period_end   TIMESTAMPTZ NOT NULL,  -- heredero directo de accessUntil
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT false,
  psp_subscription_id  TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON subscriptions (driver_id, status);
-- Un solo plan activo por conductor:
CREATE UNIQUE INDEX one_active_sub_per_driver ON subscriptions (driver_id)
  WHERE status IN ('trialing','active','past_due');

-- ─── Viajes ──────────────────────────────────────────────
CREATE TABLE trips (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  city_id             UUID NOT NULL REFERENCES cities(id),
  rider_id            UUID NOT NULL REFERENCES users(id),
  driver_id           UUID REFERENCES drivers(user_id),
  vehicle_id          UUID REFERENCES vehicles(id),
  status              TEXT NOT NULL,
  origin              GEOGRAPHY(POINT,4326) NOT NULL,
  origin_address      TEXT NOT NULL,
  destination         GEOGRAPHY(POINT,4326),
  destination_address TEXT,
  quoted_route        JSONB,        -- polyline + distancia + duración del quote
  actual_route        JSONB,        -- traza real, para disputas
  quote_id            UUID REFERENCES quotes(id),
  fare_cents          BIGINT,
  commission_bps      INT,          -- congelado al aceptar el viaje
  commission_cents    BIGINT,
  driver_earnings_cents BIGINT,
  payment_method      TEXT CHECK (payment_method IN ('cash','card','wallet')),
  cancel_reason       TEXT,
  canceled_by         TEXT CHECK (canceled_by IN ('rider','driver','system')),
  requested_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at         TIMESTAMPTZ,
  arrived_at          TIMESTAMPTZ,
  started_at          TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,
  CONSTRAINT fare_when_completed
    CHECK (status <> 'completed' OR fare_cents IS NOT NULL)
);
CREATE INDEX ON trips (driver_id, requested_at DESC);
CREATE INDEX ON trips (rider_id, requested_at DESC);
CREATE INDEX ON trips USING GIST (origin);

CREATE TABLE trip_events (          -- append-only, la historia real del viaje
  id        BIGSERIAL PRIMARY KEY,
  trip_id   UUID NOT NULL REFERENCES trips(id),
  from_status TEXT,
  to_status   TEXT NOT NULL,
  actor_id  UUID REFERENCES users(id),
  payload   JSONB,
  at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE quotes (               -- tarifa firmada por el servidor
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rider_id      UUID NOT NULL REFERENCES users(id),
  city_id       UUID NOT NULL REFERENCES cities(id),
  origin        GEOGRAPHY(POINT,4326) NOT NULL,
  destination   GEOGRAPHY(POINT,4326) NOT NULL,
  distance_m    INT NOT NULL,
  duration_s    INT NOT NULL,
  surge_multiplier NUMERIC(4,2) NOT NULL DEFAULT 1.00,
  fare_cents    BIGINT NOT NULL,
  breakdown     JSONB NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,   -- 2 minutos
  signature     TEXT NOT NULL           -- HMAC; el cliente no puede alterarla
);

-- ─── Ofertas de dispatch ─────────────────────────────────
CREATE TABLE trip_offers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id     UUID NOT NULL REFERENCES trips(id),
  driver_id   UUID NOT NULL REFERENCES drivers(user_id),
  wave        INT NOT NULL,
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  outcome     TEXT CHECK (outcome IN ('accepted','rejected','timeout','superseded')),
  decided_at  TIMESTAMPTZ,
  UNIQUE (trip_id, driver_id, wave)
);

-- ─── Dinero: ledger de doble entrada ─────────────────────
CREATE TABLE accounts (
  id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID REFERENCES users(id),        -- NULL = cuenta de la plataforma
  kind     TEXT NOT NULL CHECK (kind IN
             ('driver_balance','rider_wallet','platform_revenue',
              'psp_clearing','cash_in_transit','promo_liability')),
  currency CHAR(3) NOT NULL,
  UNIQUE (owner_id, kind, currency)
);

CREATE TABLE ledger_entries (       -- INMUTABLE. Sin UPDATE, sin DELETE.
  id             BIGSERIAL PRIMARY KEY,
  transaction_id UUID NOT NULL,     -- agrupa las patas; deben sumar 0
  account_id     UUID NOT NULL REFERENCES accounts(id),
  amount_cents   BIGINT NOT NULL,   -- signo: + debe, − haber
  currency       CHAR(3) NOT NULL,
  ref_type       TEXT NOT NULL,     -- 'trip'|'subscription'|'payout'|'adjustment'
  ref_id         UUID,
  idempotency_key TEXT UNIQUE,      -- la red va a duplicar. Esto lo absorbe.
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON ledger_entries (account_id, created_at DESC);
CREATE INDEX ON ledger_entries (transaction_id);

CREATE TABLE payouts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id      UUID NOT NULL REFERENCES drivers(user_id),
  amount_cents   BIGINT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN
                   ('pending','processing','paid','failed')),
  psp_transfer_id TEXT,
  period_start   DATE NOT NULL,
  period_end     DATE NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Confianza y auditoría ───────────────────────────────
CREATE TABLE ratings (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id    UUID NOT NULL REFERENCES trips(id),
  rater_id   UUID NOT NULL REFERENCES users(id),
  ratee_id   UUID NOT NULL REFERENCES users(id),
  stars      INT NOT NULL CHECK (stars BETWEEN 1 AND 5),
  tags       TEXT[],
  comment    TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (trip_id, rater_id)
);

CREATE TABLE audit_log (            -- el admin no puede borrar de acá
  id         BIGSERIAL PRIMARY KEY,
  actor_id   UUID REFERENCES users(id),
  action     TEXT NOT NULL,
  target_type TEXT,
  target_id  UUID,
  before     JSONB,
  after      JSONB,
  ip         INET,
  at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Posiciones de conductor no van a Postgres.** A 1 escritura cada 4 segundos por conductor, 200 conductores son 4.3 millones de escrituras por día — vas a matar la base con vacuum. Van a Redis:

```
GEOADD  drivers:online:{city_id}  <lon> <lat> <driver_id>
SETEX   driver:pos:{driver_id}  30  '{"lat":..,"lng":..,"bearing":..,"at":..}'
```

Redis `GEOSEARCH` resuelve el radio. Postgres solo recibe la traza del viaje al completarse (`trips.actual_route`), comprimida.

---

## 5. Máquina de estados del viaje

Esta es la pieza donde la mayoría de los clones de Uber se rompen. Estados explícitos, transiciones explícitas, y **nada de transiciones implícitas desde el cliente**.

```
                    ┌──────────┐
                    │ REQUESTED│ ← rider confirma un quote válido
                    └────┬─────┘
              ┌──────────┼──────────┐
              │          │          │
        (sin oferta)  (ofertado) (rider cancela)
              │          │          │
      ┌───────▼──────┐   │    ┌─────▼──────┐
      │ NO_DRIVERS   │   │    │ CANCELED   │
      └──────────────┘   │    └────────────┘
                    ┌────▼─────┐
                    │ MATCHING │ ← olas de ofertas, 15 s cada una
                    └────┬─────┘
                  (acepta)│(se agotan las olas → NO_DRIVERS)
                    ┌────▼─────┐
                    │ ACCEPTED │ ← driver_id congelado, commission_bps congelado
                    └────┬─────┘
                         │ (driver llega al origen)
                    ┌────▼─────┐
                    │ ARRIVED  │ ← arranca la ventana de espera (5 min gratis)
                    └────┬─────┘
                         │ (driver confirma pasajero a bordo)
                    ┌────▼─────┐
                    │IN_PROGRESS│ ← empieza la traza real
                    └────┬─────┘
                         │ (driver termina)
                    ┌────▼─────┐
                    │ COMPLETED│ → tarifa final, ledger, ratings
                    └──────────┘

Cancelaciones: REQUESTED/MATCHING → CANCELED sin cargo.
               ACCEPTED/ARRIVED   → CANCELED con cargo si pasaron > 2 min
                                     desde ACCEPTED (fee al conductor).
Terminales: COMPLETED · CANCELED · NO_DRIVERS.
```

**Reglas no negociables:**

- Toda transición se escribe en `trip_events`. La tabla `trips` es una vista materializada del último estado; `trip_events` es la verdad histórica.
- `commission_bps` se **copia** a `trips` en `ACCEPTED`. Si el conductor cambia de plan a mitad del viaje, la comisión del viaje no se mueve. Sin esto, tu contabilidad es indefendible.
- La tarifa final se calcula **en el servidor** al pasar a `COMPLETED`, usando `quoted_route` más ajustes por desvío real y espera. El cliente informa; el servidor decide.
- Toda transición pedida por el cliente lleva `Idempotency-Key`. "Aceptar" apretado dos veces no puede generar dos viajes.
- Timeout de barrido: un viaje en `ACCEPTED` sin `arrived_at` a los 30 minutos se marca para revisión de soporte. Los viajes zombie son un clásico.

---

## 6. Motor de dispatch

El corazón del producto. Lo que el pasajero compra es tiempo de espera.

### Algoritmo (olas con ofertas exclusivas)

```
al llegar un trip en REQUESTED:
  candidatos = Redis.GEOSEARCH(drivers:online:{city}, origen, radio=3km)
  candidatos = filtrar(candidatos):
      - onboarding_status == 'approved'
      - suscripción vigente (o plan free)
      - sin viaje activo  (lock en Redis)
      - categoría de vehículo compatible
      - documentos no vencidos
      - no rechazó este mismo trip antes
  puntaje(c) = w1 · (1/eta_seg)
             + w2 · rating
             + w3 · tasa_aceptacion
             − w4 · minutos_ocioso_invertido      ← equidad de ingresos
             − w5 · penalidad_cancelaciones
  ola 1: top 3 → oferta exclusiva, 15 s
  si nadie acepta → ola 2: siguientes 5, radio 5 km, 15 s
  si nadie acepta → ola 3: radio 8 km, 20 s
  si nadie acepta → NO_DRIVERS, avisar al rider, sugerir reintentar
```

**Decisiones que importan:**

- **Ofertas exclusivas, no broadcast.** El broadcast ("le llega a todos, gana el que aprieta primero") es más fácil de programar y arruina la experiencia del conductor: mira el celular manejando y pierde. Además premia el reflejo, no la cercanía.
- **`SET NX` en Redis como lock por conductor** durante la oferta. Sin eso, dos viajes simultáneos ofertan al mismo conductor y uno queda huérfano.
- **ETA con Mapbox Matrix, no distancia en línea recta.** En Montevideo la rambla y el Centro tienen geometrías que hacen que la línea recta mienta por minutos.
- **El término de equidad (`w4`) no es caridad, es retención.** Si el ranking es solo ETA + rating, los mismos cinco conductores se llevan todo y el resto se va en dos semanas. Perdés densidad, que es el activo.
- **Cachear la matriz de ETA** por celda de grilla y minuto. Si no, la factura de Mapbox te va a sorprender.

### Contra qué comparás

Uber en Montevideo asigna típicamente en segundos con ETAs de 3-6 minutos en zonas céntricas. Con 30 conductores en línea vas a estar en 8-15 minutos. **Ese es el número que decide si el producto vive**, no la tarifa. Instrumentá `time_to_match` y `eta_at_accept` como métricas de producto de primer nivel desde el primer día.

---

## 7. Motor de tarifas y comisiones

### Tarifa

```
base = tarifa_base
     + (distancia_km × precio_por_km)
     + (duracion_min × precio_por_min)
tarifa = max(base, tarifa_minima) × multiplicador_surge
       + peajes + recargo_aeropuerto
```

Todos los parámetros viven en `city_pricing`, versionados por fecha de vigencia. Cambiás precios sin deployar.

El quote se firma con HMAC y vive 2 minutos (`quotes.signature`, `quotes.expires_at`). El cliente manda el `quote_id`; el servidor revalida firma y vencimiento antes de crear el viaje. **Nunca aceptes una tarifa que venga en el body del request.**

### Comisión por plan

```
commission_bps = plan_del_conductor.commission_bps   (congelado en ACCEPTED)
commission_cents      = round_half_even(fare_cents × commission_bps / 10000)
driver_earnings_cents = fare_cents − commission_cents
```

**Advertencia crítica sobre el plan Pro.** Con comisión 2% y pago con tarjeta, la aritmética no cierra:

```
Viaje de $500 UYU, conductor Pro:
  comisión que cobrás        =  $10,00  (2%)
  costo de procesar tarjeta  ≈  $17,50  (~3,5% — verificar con MercadoPago)
  ─────────────────────────────────────
  resultado por viaje        =  −$7,50
```

Perdés dinero en cada viaje con tarjeta de un conductor Pro, antes de contar soporte, mapas o servidores. La suscripción de US$ 70 tapa el agujero solo si el conductor hace pocos viajes — o sea que **tu mejor cliente es el que menos usa el producto.** Eso es un modelo de negocio invertido.

Tres salidas, no excluyentes:

1. **Comisión Pro a 5%.** Sigue siendo menos de la mitad de Uber y cubre el procesamiento. El break-even del conductor pasa a `70/0,07 = US$ 1.000/mes`.
2. **Fee de servicio del lado del pasajero** (monto fijo por viaje, ej. $20 UYU) que absorbe el procesamiento. Es lo que hace la industria.
3. **Pro solo con efectivo o wallet precargada.** El efectivo no tiene costo de procesamiento, pero te obliga a resolver cobranza de comisión al conductor — más fricción operativa.

Recomiendo **(1) + (2)**. Y el plan Plus de US$ 150 no tiene mercado en Uruguay con estos números: el break-even contra Pro exige facturar más de lo que factura un conductor full-time. Guardalo para cuando entres a un mercado de ingresos más altos, o convertilo en algo que no sea comisión (prioridad en dispatch, seguro incluido, soporte dedicado).

El detalle está corrido en `03-modelo-financiero.xlsx`.

---

## 8. Pagos, ledger y payouts

### Ejemplo: viaje de $500 UYU con tarjeta, conductor Pro al 5%

Toda operación de dinero es una transacción balanceada. Las patas suman cero. Siempre.

```
transaction_id = T1   ref: trip/abc   idempotency_key: trip:abc:capture

  psp_clearing        +50000   (debe: entra la plata del PSP)
  driver_balance      −47500   (haber: se le debe al conductor)
  platform_revenue     −2500   (haber: comisión 5%)
                       ──────
                            0  ✓
```

Cobro de suscripción:
```
transaction_id = T2   ref: subscription/xyz

  psp_clearing        +70000
  platform_revenue    −70000
```

Payout semanal al conductor:
```
transaction_id = T3   ref: payout/def

  driver_balance      +47500   (se cancela lo que se le debía)
  psp_clearing        −47500
```

**Invariante que se testea en CI:** `SELECT transaction_id, SUM(amount_cents) FROM ledger_entries GROUP BY transaction_id HAVING SUM(amount_cents) <> 0` debe devolver cero filas. Si alguna vez devuelve una fila, hay un bug de dinero y la build no pasa.

### Reglas operativas

- **Webhooks del PSP son la única fuente de verdad de un cobro.** El "success" que devuelve el cliente no significa que la plata llegó. Encolá el webhook, procesá idempotentemente.
- **Máquina de estados de suscripción con dunning:** `trialing → active → past_due → (reintentos día 1/3/5/7) → expired`. Al pasar a `expired`, el conductor cae automáticamente a plan Free al 12%; no lo eches de la plataforma. Perder al conductor por un problema de tarjeta es autolesión.
- **Efectivo:** el pasajero paga al conductor, así que la comisión queda a cobrar. Se acumula en `driver_balance` en negativo y se descuenta del payout siguiente o se cobra a la tarjeta de la suscripción. Poné un techo de deuda; pasado el techo, el conductor no recibe más viajes.
- **Cuota de MercadoPago:** verificá las tasas vigentes antes de fijar precios. Las que uso en el modelo son estimaciones y mueven todo el resultado.

---

## 9. Las tres suites

### App Pasajero

| Prioridad | Pantallas y capacidades |
|---|---|
| **P0** | Alta con teléfono/OTP · Mapa con origen autodetectado (GPS) y ajustable arrastrando · Búsqueda de destino con autocomplete · Quote con desglose y ETA · Solicitar y ver el matching · Seguimiento en vivo del conductor con datos de patente y vehículo · Cancelar con política visible · Pago efectivo o tarjeta · Calificar |
| **P1** | Direcciones guardadas (casa, trabajo) · Historial y recibos · Compartir viaje por link · Botón de emergencia · Programar viaje |
| **P2** | Múltiples paradas · Viaje para otra persona · Códigos de referido · Categorías de vehículo |

Lo que decide la adopción son tres cosas: que el origen se detecte bien, que el autocomplete entienda cómo escribe la gente las direcciones en Montevideo ("Rivera y Comercio", "18 de Julio 1234"), y que el marcador del conductor se mueva suave. Esa última es puro detalle de implementación —interpolación entre pings, no saltos— y es lo que hace que la app se sienta profesional o hecha a las apuradas.

### Suite Conductor

| Prioridad | Pantallas y capacidades |
|---|---|
| **P0** | Alta con carga de documentos y estado de revisión · Toggle En línea/Fuera de línea · Ubicación en background con foreground service · Tarjeta de oferta con countdown, origen, destino y ganancia estimada · Navegación paso a paso (deep link a Google Maps/Waze al inicio, propia después) · Flujo del viaje (llegué / a bordo / terminé) · Ganancias del día y de la semana · Estado del plan con countdown de vencimiento |
| **P1** | Elección y cambio de plan con checkout · Detalle de payouts · Vencimiento de documentos con alerta anticipada · Mapa de calor de demanda · Métricas de aceptación y cancelación · Modo descanso |
| **P2** | Metas e incentivos · Referidos de conductores · Programar disponibilidad |

**El countdown de vencimiento de acceso que ya construiste** (`Trial · 2d 14h`, `Activo · 5h 12m`) va acá casi sin cambios. Es buena UX: el conductor ve exactamente qué le queda. Mantenelo.

Restricción técnica seria: ubicación en background. En Android necesitás foreground service con notificación persistente y vas a pelear con las optimizaciones de batería de cada fabricante (Xiaomi y Huawei son los peores). En iOS necesitás el modo de background location con justificación en la review de App Store. **Presupuestá dos semanas solo para esto** y no lo dejes para el final: si falla, no hay producto.

### Suite Admin

| Prioridad | Módulos |
|---|---|
| **P0** | Cola de aprobación de conductores con visor de documentos · Buscador de conductores con estado, plan y vencimiento · Otorgar/extender/vencer acceso (presets 24h/7d/15d/30d + cantidad libre — portado del panel actual) · Monitor de viajes en vivo sobre mapa · Detalle de viaje con timeline de `trip_events` · Suspender y reactivar cuentas · `audit_log` de toda acción admin |
| **P1** | Editor de tarifas y planes por ciudad · Cola de disputas con ajustes al ledger · Panel de payouts · Métricas operativas (viajes, tiempo de match, tasa de cancelación, conductores en línea) · Roles y permisos (admin / soporte / finanzas) |
| **P2** | Cercos geográficos y zonas de surge · Campañas y promociones · Reportes de conciliación exportables · Feature flags por ciudad |

Los patrones de UX del panel actual se rescatan enteros: los presets de duración, el countdown vivo por conductor, el badge de estado, el contador de solicitudes pendientes. Ese diseño ya está pensado; solo cambia la implementación.

---

## 10. Seguridad, confianza y cumplimiento

Lo que arrastrás de la auditoría (`01-auditoria-seguridad.md`) y no puede repetirse:

- **Autorización en el servidor, siempre.** El cliente nunca decide acceso, tarifa ni asignación.
- **Roles por Custom Claims,** nunca por email hardcodeado. El admin no se define en un archivo JS.
- **App Check con enforcement** en toda la superficie de API.
- **Sin PINs de 4 dígitos como credencial.** Teléfono/OTP como primario, biometría del dispositivo para desbloqueo rápido.
- **`audit_log` inmutable** para acciones administrativas. El admin no puede borrar su propio rastro.
- **Documentos en almacenamiento privado** con URLs firmadas de vida corta. Nunca públicas.

Confianza y seguridad del producto:

- Verificación de antecedentes del conductor antes de aprobar, y revisión de vencimiento de libreta y seguro (`driver_documents.expires_at`) con alerta a 30 días.
- Botón de emergencia con ubicación en vivo, en las dos apps.
- Compartir viaje por link con acceso temporal.
- Matching de foto del conductor y patente visible para el pasajero antes de subir.
- Datos de contacto enmascarados: llamadas y mensajes por proxy, nunca el número real.
- Detección de fraude: patrones de viaje corto repetido entre las mismas dos cuentas, GPS falseado (comparar traza contra ruta plausible), conductores que aceptan y cancelan sistemáticamente.

Cumplimiento en Uruguay — esto no es opcional y tiene plazos:

- **Ley 18.331** de protección de datos: registro como base de datos ante la URCDP, finalidad declarada, consentimiento, y derechos de acceso, rectificación y supresión implementados. La geolocalización es dato de granularidad alta; tratala con el mismo cuidado que un dato sensible.
- **Regulación municipal de transporte por aplicación.** Montevideo tiene régimen propio para plataformas y para vehículos con permiso. Averiguá los requisitos antes de escribir código, no después de lanzar.
- **Clasificación laboral del conductor.** Autónomo vs. dependiente es un riesgo material en la región; hay jurisprudencia en varios países que fue en contra de las plataformas.
- **IVA sobre la suscripción** y sobre la comisión. Facturación electrónica ante DGI.
- **Seguro:** cobertura de responsabilidad civil durante el viaje. Los seguros personales de los conductores suelen excluir el transporte oneroso.

Empezá con abogado y contador **en la fase 0**. Enterarte de un requisito regulatorio después de tener 200 conductores es la forma más caras de aprender.

---

## 11. Roadmap

Fases por resultado, no por calendario. Los tiempos suponen 2-3 devs; ajustá.

### Fase 0 — Fundaciones y validación (3-4 semanas)

No se escribe código de producto todavía.

- Constitución legal, consulta regulatoria, consulta de seguro
- Verificar tasas reales de MercadoPago Uruguay → cerrar el modelo financiero
- 15 entrevistas a conductores: ¿pagarían US$ 70/mes? ¿cuánto facturan hoy? ¿qué los haría cambiar?
- 15 entrevistas a pasajeros: ¿qué tolerancia de espera tienen? ¿cuánto ahorro justifica cambiar de app?
- Cerrar precios de planes y comisiones con los datos de arriba
- Arreglar los hallazgos críticos de la auditoría en la app actual
- Repo monorepo, CI, entornos, esqueleto de observabilidad

**Criterio de salida:** conocés tus números reales y sabés si el modelo cierra. Si las entrevistas dicen que nadie paga US$ 70, mejor enterarte ahora que con la app construida.

### Fase 1 — MVP de un solo lado (6-8 semanas)

Una ciudad (Montevideo), una categoría de vehículo, **solo plan Free al 12%**, **solo efectivo**.

- Backend: auth, usuarios, conductores, quotes, viajes, máquina de estados, dispatch, WebSocket
- App pasajero P0 completa
- App conductor P0 completa
- Admin P0 completa
- Ledger funcionando (comisión a cobrar en efectivo, sin payouts todavía)
- 10 conductores reclutados a mano, 50 pasajeros de prueba

**Por qué sin suscripciones:** vender un plan antes de tener liquidez es vender aire. Primero probás que el matching funciona y que la gente vuelve. Las suscripciones son un problema de monetización y se resuelven después de tener un producto que la gente use.

**Criterio de salida:** 100 viajes completados con tiempo de match mediano bajo 5 minutos y menos del 15% de cancelaciones. Si no llegás a esos números, el problema es el dispatch o la densidad, y agregar features no lo arregla.

### Fase 2 — Pagos y monetización (4-6 semanas)

- Integración MercadoPago: tarjeta en el viaje + suscripciones recurrentes
- Planes Free y Pro activos, con dunning
- Payouts semanales automáticos
- Wallet del pasajero
- Fee de servicio del lado del pasajero
- Panel de finanzas en el admin, conciliación

**Criterio de salida:** primer cobro de suscripción y primer payout ejecutados y conciliados sin intervención manual.

### Fase 3 — Confianza y escala (6-8 semanas)

- Verificación de antecedentes en el onboarding
- SOS, compartir viaje, contacto por proxy
- Ratings con consecuencias (desactivación por rating bajo)
- Surge por zona y horario
- Categorías de vehículo
- Programar viajes
- Cola de disputas con ajustes al ledger
- Detección de fraude

**Criterio de salida:** 1.000 viajes por semana, cero incidentes de seguridad, NPS medido.

### Fase 4 — Segunda ciudad (4 semanas)

Todo lo que quedó hardcodeado a Montevideo se rompe acá. Punta del Este es un buen segundo mercado: estacional, tickets altos, y ya tenés conocimiento del corredor por el negocio de traslados.

- Configuración multi-ciudad completa
- Feature flags por mercado
- Playbook de lanzamiento de ciudad

---

## 12. Riesgos, ordenados por probabilidad de matarte

| Riesgo | Por qué duele | Mitigación |
|---|---|---|
| **Arranque en frío de la oferta** | Sin conductores no hay pasajeros y al revés. Es el problema #1 de todo marketplace. | Lanzá en un barrio, no en la ciudad. Garantía de ingreso por hora a los primeros 20 conductores. Free al 12% para no poner fricción. |
| **Uber baja la comisión en Montevideo** | Puede aguantar pérdidas años. Vos no. | No compitas por precio solo. Competí en lo que a Uber le cuesta copiar: pago al conductor a las 24h, soporte humano en español, relación directa. La lealtad del conductor es defendible; el precio no. |
| **Aritmética del Pro al 2%** | Perdés plata en cada viaje con tarjeta. | Subir Pro a 5% + fee al pasajero. Ver sección 7. |
| **Regulatorio** | Un requisito de permiso puede pararte la operación de un día para el otro. | Consulta legal en fase 0. Presupuestá los permisos. |
| **Ubicación en background en Android** | Si el conductor "desaparece" del mapa, el producto no funciona. | Dos semanas dedicadas. Probá en Xiaomi y Samsung reales, no en emulador. |
| **Incidente de seguridad con un pasajero** | Riesgo existencial y reputacional. Un caso te cierra la empresa. | Verificación de antecedentes antes del primer viaje, sin excepciones. SOS desde el día 1. Seguro. |
| **Selección adversa en los planes** | Solo los conductores de alto volumen compran Pro; tu take rate mezclado se desploma. | Modelar el mix (está en el xlsx). Considerá techo de viajes en Pro. |
| **Costo de Mapbox** | Las llamadas de Directions y Matrix escalan con los intentos de dispatch, no con los viajes. | Cachear matrices por celda y minuto. Alertas de presupuesto. Medilo desde el primer día. |

---

## 13. Decisiones abiertas

Cosas que necesitan tu respuesta antes de la fase 1:

1. **¿Mercado inicial es Montevideo o Punta del Este?** Punta tiene tickets más altos y estacionalidad; Montevideo tiene volumen constante y más competencia.
2. **¿El negocio de traslados actual se integra o queda separado?** Podés convertir los viajes programados de aeropuerto en una categoría de Orbit con márgenes mucho mejores que el viaje urbano. Es una ventaja que Uber no tiene en ese corredor.
3. **¿Los conductores actuales de APTraslados son la semilla de la oferta?** Si ya tenés relación con ellos, resolvés parcialmente el arranque en frío — que es el riesgo #1.
4. **¿Presupuesto y horizonte de runway?** Determina si la fase 1 es un MVP para validar o un lanzamiento comercial.
5. **¿Qué es el plan Plus si no es comisión más baja?** Prioridad en dispatch, seguro incluido, soporte dedicado — hay opciones, pero hoy no tiene contenido.

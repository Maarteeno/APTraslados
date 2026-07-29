-- 0004 · Cotizaciones, viajes, eventos y ofertas de dispatch

CREATE TABLE quotes (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rider_id         UUID NOT NULL REFERENCES users(id),
  city_id          UUID NOT NULL REFERENCES cities(id),
  origin           GEOGRAPHY(POINT, 4326) NOT NULL,
  origin_address   TEXT,
  destination      GEOGRAPHY(POINT, 4326) NOT NULL,
  destination_address TEXT,
  distance_meters  INT NOT NULL CHECK (distance_meters >= 0),
  duration_seconds INT NOT NULL CHECK (duration_seconds >= 0),
  surge_multiplier NUMERIC(4,2) NOT NULL DEFAULT 1.00 CHECK (surge_multiplier BETWEEN 1 AND 5),
  fare_cents       BIGINT NOT NULL CHECK (fare_cents >= 0),
  currency         CHAR(3) NOT NULL,
  breakdown        JSONB NOT NULL,
  -- HMAC del payload. El cliente manda el id; el servidor revalida firma y vigencia.
  signature        TEXT NOT NULL,
  expires_at       TIMESTAMPTZ NOT NULL,
  consumed_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX quotes_rider_idx ON quotes (rider_id, created_at DESC);
CREATE INDEX quotes_expiry_idx ON quotes (expires_at) WHERE consumed_at IS NULL;

CREATE TYPE trip_status AS ENUM
  ('REQUESTED', 'MATCHING', 'ACCEPTED', 'ARRIVED', 'IN_PROGRESS',
   'COMPLETED', 'CANCELED', 'NO_DRIVERS');
CREATE TYPE payment_method AS ENUM ('cash', 'card', 'wallet');
CREATE TYPE trip_actor AS ENUM ('rider', 'driver', 'system');

CREATE TABLE trips (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  city_id               UUID NOT NULL REFERENCES cities(id),
  rider_id              UUID NOT NULL REFERENCES users(id),
  driver_id             UUID REFERENCES drivers(user_id),
  vehicle_id            UUID REFERENCES vehicles(id),
  quote_id              UUID NOT NULL REFERENCES quotes(id),
  status                trip_status NOT NULL,

  origin                GEOGRAPHY(POINT, 4326) NOT NULL,
  origin_address        TEXT,
  destination           GEOGRAPHY(POINT, 4326) NOT NULL,
  destination_address   TEXT,
  quoted_route          JSONB,
  actual_route          JSONB,        -- traza real, para resolver disputas

  fare_cents            BIGINT CHECK (fare_cents IS NULL OR fare_cents >= 0),
  currency              CHAR(3) NOT NULL,
  -- CONGELADO al pasar a ACCEPTED. Si el conductor cambia de plan a mitad del
  -- viaje, la comisión del viaje no se mueve. Sin esto la contabilidad no se
  -- puede defender frente a una disputa.
  commission_bps        INT CHECK (commission_bps IS NULL OR commission_bps BETWEEN 0 AND 10000),
  commission_cents      BIGINT CHECK (commission_cents IS NULL OR commission_cents >= 0),
  driver_earnings_cents BIGINT CHECK (driver_earnings_cents IS NULL OR driver_earnings_cents >= 0),
  payment_method        payment_method NOT NULL,

  cancel_reason         TEXT,
  canceled_by           trip_actor,
  cancellation_fee_cents BIGINT NOT NULL DEFAULT 0 CHECK (cancellation_fee_cents >= 0),

  requested_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at           TIMESTAMPTZ,
  arrived_at            TIMESTAMPTZ,
  started_at            TIMESTAMPTZ,
  completed_at          TIMESTAMPTZ,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Coherencia estado ↔ datos, garantizada por la base.
  CONSTRAINT trip_completed_has_fare CHECK (
    status <> 'COMPLETED' OR (fare_cents IS NOT NULL AND commission_bps IS NOT NULL
                              AND completed_at IS NOT NULL)),
  CONSTRAINT trip_assigned_has_driver CHECK (
    status NOT IN ('ACCEPTED','ARRIVED','IN_PROGRESS','COMPLETED')
    OR (driver_id IS NOT NULL AND accepted_at IS NOT NULL)),
  CONSTRAINT trip_canceled_has_actor CHECK (
    status <> 'CANCELED' OR canceled_by IS NOT NULL),
  CONSTRAINT trip_commission_le_fare CHECK (
    commission_cents IS NULL OR fare_cents IS NULL OR commission_cents <= fare_cents)
);

CREATE INDEX trips_driver_idx   ON trips (driver_id, requested_at DESC);
CREATE INDEX trips_rider_idx    ON trips (rider_id, requested_at DESC);
CREATE INDEX trips_status_idx   ON trips (status) WHERE status NOT IN ('COMPLETED','CANCELED','NO_DRIVERS');
CREATE INDEX trips_origin_gix   ON trips USING GIST (origin);

-- Un conductor no puede tener dos viajes activos. Invariante en la base:
-- el lock de Redis es una optimización, esto es la garantía.
CREATE UNIQUE INDEX trips_one_active_per_driver ON trips (driver_id)
  WHERE status IN ('ACCEPTED','ARRIVED','IN_PROGRESS') AND driver_id IS NOT NULL;

-- Un pasajero tampoco puede tener dos viajes abiertos.
CREATE UNIQUE INDEX trips_one_open_per_rider ON trips (rider_id)
  WHERE status IN ('REQUESTED','MATCHING','ACCEPTED','ARRIVED','IN_PROGRESS');

-- Bitácora append-only. Es la verdad histórica; `trips` es el último estado.
CREATE TABLE trip_events (
  id          BIGSERIAL PRIMARY KEY,
  trip_id     UUID NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  from_status trip_status,
  to_status   trip_status NOT NULL,
  actor       trip_actor NOT NULL,
  actor_id    UUID REFERENCES users(id),
  payload     JSONB,
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX trip_events_trip_idx ON trip_events (trip_id, id);

-- Sin UPDATE ni DELETE sobre la bitácora: si se pudiera editar, no sirve como prueba.
CREATE OR REPLACE FUNCTION trip_events_append_only() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'trip_events es append-only: no se permite % ', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trip_events_no_update BEFORE UPDATE ON trip_events
  FOR EACH ROW EXECUTE FUNCTION trip_events_append_only();
CREATE TRIGGER trip_events_no_delete BEFORE DELETE ON trip_events
  FOR EACH ROW EXECUTE FUNCTION trip_events_append_only();

CREATE TYPE offer_outcome AS ENUM ('accepted', 'rejected', 'timeout', 'superseded');

CREATE TABLE trip_offers (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id    UUID NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  driver_id  UUID NOT NULL REFERENCES drivers(user_id),
  wave       INT NOT NULL CHECK (wave >= 1),
  eta_seconds INT,
  distance_meters INT,
  score      NUMERIC(8,4),
  sent_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  outcome    offer_outcome,
  decided_at TIMESTAMPTZ,
  -- Un conductor recibe como máximo una oferta por viaje: nunca dos veces el
  -- mismo viaje, ni en la misma ola ni en otra.
  UNIQUE (trip_id, driver_id)
);

CREATE INDEX trip_offers_open_idx ON trip_offers (driver_id, expires_at) WHERE outcome IS NULL;
CREATE INDEX trip_offers_trip_idx ON trip_offers (trip_id, wave);

-- Solo una oferta aceptada por viaje.
CREATE UNIQUE INDEX trip_offers_one_accepted ON trip_offers (trip_id) WHERE outcome = 'accepted';

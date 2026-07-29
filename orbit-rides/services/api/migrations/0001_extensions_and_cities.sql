-- 0001 · Extensiones y ciudades
-- La ciudad es la unidad de configuración: tarifas, planes y reglas varían por
-- mercado. Nada hardcodeado a Montevideo.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "postgis";    -- geografía y índices GiST

CREATE TABLE cities (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  country_code  CHAR(2) NOT NULL,
  currency      CHAR(3) NOT NULL,
  timezone      TEXT NOT NULL,
  -- Polígono operativo. Fuera de esto no se toman viajes.
  boundary      GEOGRAPHY(POLYGON, 4326) NOT NULL,
  is_live       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX cities_boundary_gix ON cities USING GIST (boundary);

-- Tarifas versionadas por vigencia: se cambian precios sin deployar código.
-- Nunca se hace UPDATE de una fila vigente; se inserta una nueva.
CREATE TABLE city_pricing (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  city_id           UUID NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
  base_cents        BIGINT NOT NULL CHECK (base_cents >= 0),
  per_km_cents      BIGINT NOT NULL CHECK (per_km_cents >= 0),
  per_minute_cents  BIGINT NOT NULL CHECK (per_minute_cents >= 0),
  minimum_cents     BIGINT NOT NULL CHECK (minimum_cents >= 0),
  service_fee_cents BIGINT NOT NULL DEFAULT 0 CHECK (service_fee_cents >= 0),
  round_to_cents    BIGINT NOT NULL DEFAULT 100 CHECK (round_to_cents >= 0),
  cancellation_fee_cents BIGINT NOT NULL DEFAULT 0 CHECK (cancellation_fee_cents >= 0),
  cancellation_grace_seconds INT NOT NULL DEFAULT 120 CHECK (cancellation_grace_seconds >= 0),
  effective_from    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (city_id, effective_from)
);

CREATE INDEX city_pricing_lookup ON city_pricing (city_id, effective_from DESC);

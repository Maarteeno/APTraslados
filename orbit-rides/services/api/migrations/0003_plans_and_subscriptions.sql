-- 0003 · Planes y suscripciones
-- Hereda directo del modelo de acceso por duración que ya funcionaba en
-- APTraslados: current_period_end es el accessUntil de aquel sistema.

CREATE TYPE plan_code AS ENUM ('free', 'pro', 'plus');

CREATE TABLE plans (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  city_id             UUID NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
  code                plan_code NOT NULL,
  name                TEXT NOT NULL,
  monthly_fee_cents   BIGINT NOT NULL CHECK (monthly_fee_cents >= 0),
  -- Basis points: 1200 = 12 %. Entero, para no arrastrar floats al dinero.
  commission_bps      INT NOT NULL CHECK (commission_bps BETWEEN 0 AND 10000),
  max_rides_per_month INT CHECK (max_rides_per_month IS NULL OR max_rides_per_month > 0),
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  effective_from      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (city_id, code, effective_from)
);

CREATE INDEX plans_lookup ON plans (city_id, code, effective_from DESC) WHERE is_active;

CREATE TYPE subscription_status AS ENUM
  ('trialing', 'active', 'past_due', 'canceled', 'expired');

CREATE TABLE subscriptions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id            UUID NOT NULL REFERENCES drivers(user_id) ON DELETE CASCADE,
  plan_id              UUID NOT NULL REFERENCES plans(id),
  status               subscription_status NOT NULL,
  current_period_start TIMESTAMPTZ NOT NULL,
  -- El "accessUntil" de siempre. El conductor opera mientras esto esté vigente.
  current_period_end   TIMESTAMPTZ NOT NULL,
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
  psp_subscription_id  TEXT,
  -- Dunning: cuántos reintentos de cobro fallaron.
  failed_charge_count  INT NOT NULL DEFAULT 0 CHECK (failed_charge_count >= 0),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT period_ordered CHECK (current_period_end > current_period_start)
);

CREATE INDEX subscriptions_driver_idx ON subscriptions (driver_id, status);
CREATE INDEX subscriptions_expiry_idx ON subscriptions (current_period_end)
  WHERE status IN ('trialing', 'active', 'past_due');

-- Invariante: un conductor no puede tener dos suscripciones vigentes.
-- Se garantiza en la base, no en el código de aplicación.
CREATE UNIQUE INDEX subscriptions_one_live_per_driver ON subscriptions (driver_id)
  WHERE status IN ('trialing', 'active', 'past_due');

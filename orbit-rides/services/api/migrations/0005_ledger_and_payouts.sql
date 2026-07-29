-- 0005 · Ledger de doble entrada, payouts y calificaciones
-- Toda operación de dinero es una transacción cuyas patas suman exactamente 0.
-- La invariante se impone en la base con un trigger diferido: un asiento
-- desbalanceado no llega a existir.

CREATE TYPE account_kind AS ENUM
  ('driver_balance', 'rider_wallet', 'platform_revenue',
   'psp_clearing', 'cash_in_transit', 'promo_liability');

CREATE TABLE accounts (
  id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID REFERENCES users(id),   -- NULL = cuenta de la plataforma
  kind     account_kind NOT NULL,
  currency CHAR(3) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Una cuenta por (dueño, tipo, moneda). Las de plataforma llevan owner_id NULL,
-- y como UNIQUE no distingue NULLs se usan dos índices parciales.
CREATE UNIQUE INDEX accounts_owned_uniq   ON accounts (owner_id, kind, currency)
  WHERE owner_id IS NOT NULL;
CREATE UNIQUE INDEX accounts_platform_uniq ON accounts (kind, currency)
  WHERE owner_id IS NULL;

CREATE TYPE ledger_ref_type AS ENUM
  ('trip', 'subscription', 'payout', 'adjustment', 'cancellation_fee');

CREATE TABLE ledger_entries (
  id              BIGSERIAL PRIMARY KEY,
  -- Agrupa las patas de una misma operación. Deben sumar 0.
  transaction_id  UUID NOT NULL,
  account_id      UUID NOT NULL REFERENCES accounts(id),
  -- Signo: positivo = debe, negativo = haber.
  amount_cents    BIGINT NOT NULL CHECK (amount_cents <> 0),
  currency        CHAR(3) NOT NULL,
  ref_type        ledger_ref_type NOT NULL,
  ref_id          UUID,
  -- La red móvil duplica requests. Esto lo absorbe a nivel de base.
  idempotency_key TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX ledger_idempotency_uniq ON ledger_entries (idempotency_key, account_id);
CREATE INDEX ledger_account_idx     ON ledger_entries (account_id, created_at DESC);
CREATE INDEX ledger_transaction_idx ON ledger_entries (transaction_id);
CREATE INDEX ledger_ref_idx         ON ledger_entries (ref_type, ref_id);

-- Inmutable: sin UPDATE ni DELETE. Un error se corrige con un asiento de ajuste,
-- nunca editando el original. Así funciona la contabilidad de verdad.
CREATE OR REPLACE FUNCTION ledger_immutable() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries es inmutable: corregí con un asiento de ajuste, no con %', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_no_update BEFORE UPDATE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_immutable();
CREATE TRIGGER ledger_no_delete BEFORE DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_immutable();

-- Invariante de suma cero, verificada al final de la transacción (DEFERRABLE):
-- así se pueden insertar las patas de a una dentro de un BEGIN/COMMIT.
CREATE OR REPLACE FUNCTION ledger_balanced() RETURNS TRIGGER AS $$
DECLARE
  unbalanced RECORD;
BEGIN
  FOR unbalanced IN
    SELECT transaction_id, SUM(amount_cents) AS total
    FROM ledger_entries
    WHERE transaction_id = NEW.transaction_id
    GROUP BY transaction_id
    HAVING SUM(amount_cents) <> 0
  LOOP
    RAISE EXCEPTION
      'transacción % desbalanceada: las patas suman %, deben sumar 0',
      unbalanced.transaction_id, unbalanced.total;
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER ledger_balance_check
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_balanced();

-- Proyección de saldos. El ledger es la fuente; esto es una vista.
CREATE VIEW account_balances AS
SELECT a.id AS account_id, a.owner_id, a.kind, a.currency,
       COALESCE(SUM(e.amount_cents), 0) AS balance_cents,
       COUNT(e.id) AS entry_count,
       MAX(e.created_at) AS last_entry_at
FROM accounts a
LEFT JOIN ledger_entries e ON e.account_id = a.id
GROUP BY a.id, a.owner_id, a.kind, a.currency;

CREATE TYPE payout_status AS ENUM ('pending', 'processing', 'paid', 'failed');

CREATE TABLE payouts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id       UUID NOT NULL REFERENCES drivers(user_id),
  amount_cents    BIGINT NOT NULL CHECK (amount_cents > 0),
  currency        CHAR(3) NOT NULL,
  status          payout_status NOT NULL DEFAULT 'pending',
  psp_transfer_id TEXT,
  failure_reason  TEXT,
  period_start    DATE NOT NULL,
  period_end      DATE NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at         TIMESTAMPTZ,
  CONSTRAINT payout_period_ordered CHECK (period_end >= period_start),
  -- Un payout por conductor y período: evita pagar dos veces lo mismo.
  UNIQUE (driver_id, period_start, period_end)
);

CREATE INDEX payouts_driver_idx ON payouts (driver_id, created_at DESC);
CREATE INDEX payouts_pending_idx ON payouts (status) WHERE status IN ('pending','processing');

CREATE TABLE ratings (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id    UUID NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  rater_id   UUID NOT NULL REFERENCES users(id),
  ratee_id   UUID NOT NULL REFERENCES users(id),
  stars      INT NOT NULL CHECK (stars BETWEEN 1 AND 5),
  tags       TEXT[],
  comment    TEXT CHECK (comment IS NULL OR length(comment) <= 1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Una calificación por viaje y por persona.
  UNIQUE (trip_id, rater_id),
  CONSTRAINT rating_not_self CHECK (rater_id <> ratee_id)
);

CREATE INDEX ratings_ratee_idx ON ratings (ratee_id, created_at DESC);

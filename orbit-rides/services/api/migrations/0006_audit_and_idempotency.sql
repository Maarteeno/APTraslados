-- 0006 · Auditoría administrativa e idempotencia de requests

-- El admin no puede borrar su propio rastro. En APTraslados el admin era un
-- email hardcodeado con permiso de borrar los logs de acceso; eso no se repite.
CREATE TABLE audit_log (
  id          BIGSERIAL PRIMARY KEY,
  actor_id    UUID REFERENCES users(id),
  actor_email TEXT,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   UUID,
  before      JSONB,
  after       JSONB,
  ip          INET,
  user_agent  TEXT,
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_actor_idx  ON audit_log (actor_id, at DESC);
CREATE INDEX audit_log_target_idx ON audit_log (target_type, target_id, at DESC);

CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_log es append-only: no se permite %', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();

-- Idempotencia a nivel HTTP: "aceptar viaje" apretado dos veces, o reintentado
-- por la red, no puede producir dos efectos.
CREATE TABLE idempotency_keys (
  key            TEXT PRIMARY KEY,
  user_id        UUID REFERENCES users(id),
  endpoint       TEXT NOT NULL,
  request_hash   TEXT NOT NULL,
  response_status INT,
  response_body  JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at   TIMESTAMPTZ
);

CREATE INDEX idempotency_created_idx ON idempotency_keys (created_at);

-- Posiciones de conductor NO van acá: a 1 escritura cada 4 s por conductor,
-- 200 conductores son ~4,3 millones de escrituras diarias y el autovacuum no
-- da. Van a Redis con TTL. Esta tabla guarda solo el último snapshot conocido,
-- para reconstruir estado si Redis se cae.
CREATE TABLE driver_last_position (
  driver_id  UUID PRIMARY KEY REFERENCES drivers(user_id) ON DELETE CASCADE,
  position   GEOGRAPHY(POINT, 4326) NOT NULL,
  bearing    NUMERIC(5,2),
  is_online  BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX driver_last_position_gix ON driver_last_position USING GIST (position)
  WHERE is_online;

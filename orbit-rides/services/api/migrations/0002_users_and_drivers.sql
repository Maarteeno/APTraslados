-- 0002 · Identidad, conductores, vehículos y documentos

CREATE TYPE user_role   AS ENUM ('rider', 'driver', 'admin', 'support');
CREATE TYPE user_status AS ENUM ('active', 'suspended', 'deleted');

CREATE TABLE users (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Identidad externa (Firebase Auth). Único, pero puede ser NULL en modo dev.
  external_uid TEXT UNIQUE,
  phone_e164   TEXT NOT NULL UNIQUE CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  email        TEXT,
  full_name    TEXT NOT NULL CHECK (length(btrim(full_name)) BETWEEN 1 AND 120),
  role         user_role NOT NULL,
  status       user_status NOT NULL DEFAULT 'active',
  city_id      UUID REFERENCES cities(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Borrado lógico: requisito legal (derecho de supresión) sin romper el ledger.
  deleted_at   TIMESTAMPTZ
);

CREATE INDEX users_role_status_idx ON users (role, status) WHERE deleted_at IS NULL;
CREATE INDEX users_city_idx        ON users (city_id) WHERE deleted_at IS NULL;

CREATE TYPE onboarding_status AS ENUM
  ('documents_pending', 'under_review', 'approved', 'rejected', 'suspended');

CREATE TABLE drivers (
  user_id            UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  onboarding_status  onboarding_status NOT NULL DEFAULT 'documents_pending',
  rating_avg         NUMERIC(3,2) CHECK (rating_avg IS NULL OR rating_avg BETWEEN 1 AND 5),
  rating_count       INT NOT NULL DEFAULT 0 CHECK (rating_count >= 0),
  acceptance_rate    NUMERIC(4,3) CHECK (acceptance_rate IS NULL OR acceptance_rate BETWEEN 0 AND 1),
  cancellation_rate  NUMERIC(4,3) CHECK (cancellation_rate IS NULL OR cancellation_rate BETWEEN 0 AND 1),
  approved_at        TIMESTAMPTZ,
  suspended_reason   TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX drivers_onboarding_idx ON drivers (onboarding_status);

CREATE TYPE document_kind AS ENUM
  ('license', 'vehicle_registration', 'insurance', 'background_check',
   'profile_photo', 'vehicle_photo');
CREATE TYPE document_status AS ENUM ('pending', 'approved', 'rejected');

CREATE TABLE driver_documents (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id    UUID NOT NULL REFERENCES drivers(user_id) ON DELETE CASCADE,
  kind         document_kind NOT NULL,
  -- Clave de un objeto PRIVADO. Nunca una URL pública: se sirve con URL firmada corta.
  storage_key  TEXT NOT NULL,
  -- La libreta y el seguro vencen. Hay que vigilarlo o terminás con conductores
  -- circulando sin cobertura y con la responsabilidad puesta en la plataforma.
  expires_at   DATE,
  status       document_status NOT NULL DEFAULT 'pending',
  reviewed_by  UUID REFERENCES users(id),
  reviewed_at  TIMESTAMPTZ,
  reject_note  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX driver_documents_driver_idx  ON driver_documents (driver_id, kind);
CREATE INDEX driver_documents_expiry_idx  ON driver_documents (expires_at)
  WHERE status = 'approved' AND expires_at IS NOT NULL;

CREATE TABLE vehicles (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id  UUID NOT NULL REFERENCES drivers(user_id) ON DELETE CASCADE,
  plate      TEXT NOT NULL,
  make       TEXT NOT NULL,
  model      TEXT NOT NULL,
  year       INT NOT NULL CHECK (year BETWEEN 1990 AND 2100),
  color      TEXT NOT NULL,
  seats      INT NOT NULL DEFAULT 4 CHECK (seats BETWEEN 1 AND 20),
  category   TEXT NOT NULL DEFAULT 'standard',
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (driver_id, plate)
);

-- Un solo vehículo activo por conductor a la vez.
CREATE UNIQUE INDEX vehicles_one_active_per_driver ON vehicles (driver_id) WHERE is_active;

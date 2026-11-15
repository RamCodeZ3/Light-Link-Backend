BEGIN;
-- Aplicar con el propietario de la base. No elimina datos existentes.
CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  email text NOT NULL UNIQUE CHECK (email = lower(btrim(email)) AND length(email) <= 254),
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
-- Un mismo site_id científico admite nombres distintos por usuario.
CREATE TABLE IF NOT EXISTS user_sites (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site_id text NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL CHECK (longitude >= 0 AND longitude < 360),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, site_id)
);
CREATE TABLE IF NOT EXISTS missions (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
  start_utc timestamptz NOT NULL,
  end_utc timestamptz NOT NULL,
  step_hours integer NOT NULL DEFAULT 1 CHECK (step_hours BETWEEN 1 AND 24),
  observer_height_m integer NOT NULL DEFAULT 2 CHECK (observer_height_m IN (2,5)),
  created_at_utc timestamptz NOT NULL DEFAULT now(),
  updated_at_utc timestamptz NOT NULL DEFAULT now(),
  CHECK (end_utc > start_utc AND end_utc - start_utc <= interval '62 days')
);
CREATE INDEX IF NOT EXISTS missions_owner_idx ON missions(owner_id);
CREATE TABLE IF NOT EXISTS mission_members (
  mission_id uuid NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('viewer','editor')),
  PRIMARY KEY (mission_id,user_id)
);
CREATE INDEX IF NOT EXISTS mission_members_user_idx ON mission_members(user_id,mission_id);
CREATE TABLE IF NOT EXISTS mission_sites (
  mission_id uuid NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  site_id text NOT NULL,
  position integer NOT NULL CHECK (position >= 0 AND position < 20),
  -- Snapshot personal para compartir el sitio sin hacerlo público. NULL en los predeterminados.
  name text,
  latitude double precision,
  longitude double precision,
  PRIMARY KEY (mission_id,site_id),
  UNIQUE (mission_id,position),
  CHECK ((name IS NULL AND latitude IS NULL AND longitude IS NULL) OR
    (name IS NOT NULL AND length(btrim(name)) BETWEEN 1 AND 120 AND
     latitude IS NOT NULL AND latitude BETWEEN -90 AND 90 AND
     longitude IS NOT NULL AND longitude >= 0 AND longitude < 360))
);
CREATE INDEX IF NOT EXISTS mission_sites_site_idx ON mission_sites(site_id,mission_id);
CREATE TABLE IF NOT EXISTS auth_rate_limits (
  identity_hash text PRIMARY KEY,
  attempts integer NOT NULL CHECK (attempts > 0),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_rate_expiry_idx ON auth_rate_limits(expires_at);
INSERT INTO schema_migrations(version) VALUES ('001_accounts_missions') ON CONFLICT DO NOTHING;
COMMIT;

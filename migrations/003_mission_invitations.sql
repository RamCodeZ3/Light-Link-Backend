BEGIN;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations WHERE version = '002_remove_mission_roles'
  ) THEN
    RAISE EXCEPTION 'Aplica primero la migración 002_remove_mission_roles';
  END IF;
END;
$$;
CREATE TABLE IF NOT EXISTS mission_invitations (
  id uuid PRIMARY KEY,
  mission_id uuid NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  invited_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at_utc timestamptz NOT NULL DEFAULT now(),
  expires_at_utc timestamptz NOT NULL DEFAULT now() + interval '7 days',
  UNIQUE (mission_id, invited_user_id),
  CHECK (expires_at_utc > created_at_utc)
);
CREATE INDEX IF NOT EXISTS mission_invitations_user_idx
  ON mission_invitations(invited_user_id, expires_at_utc);
GRANT SELECT, INSERT, UPDATE, DELETE ON mission_invitations TO light_link_app;
INSERT INTO schema_migrations(version)
VALUES ('003_mission_invitations') ON CONFLICT DO NOTHING;
COMMIT;

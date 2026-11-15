BEGIN;
-- Conserva todos los colaboradores; elimina la clasificación de permisos.
ALTER TABLE mission_members DROP COLUMN IF EXISTS role;
INSERT INTO schema_migrations(version)
VALUES ('002_remove_mission_roles') ON CONFLICT DO NOTHING;
COMMIT;

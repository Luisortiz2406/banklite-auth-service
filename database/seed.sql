-- Datos de ejemplo de auth_db (auth-service). Escenario de demo compartido por todos
-- los microservicios (mismos UUID): Ana Pérez y Carlos Gómez, clientes de prueba,
-- y una cuenta de comercio. Datos inventados: no son personas ni documentos reales.
-- Cargar después del esquema:  psql "$DATABASE_URL" -f database/schema.sql -f database/seed.sql
-- (si la base ya tiene estas filas, ON CONFLICT DO NOTHING las deja como están)

BEGIN;
-- password_hash 'sin-clave-solo-demo' no es un hash válido: estos clientes no pueden
-- iniciar sesión (no se suben claves). Para entrar a la app, registra un cliente nuevo.
-- Empleados del panel: el primer administrador se crea al arrancar con
-- ADMIN_BOOTSTRAP_USERNAME / ADMIN_BOOTSTRAP_PASSWORD (variables de entorno).
INSERT INTO public.usuarios_auth (id_user, email, username, password_hash, status, created_at) VALUES
  ('11111111-1111-4111-8111-111111111111', 'ana.perez@banklite.test', 'anaperez', 'sin-clave-solo-demo', 'active', '2026-10-01 09:00:00-05'),
  ('22222222-2222-4222-8222-222222222222', 'carlos.gomez@banklite.test', 'carlosgomez', 'sin-clave-solo-demo', 'active', '2026-10-01 09:05:00-05')
ON CONFLICT DO NOTHING;

COMMIT;

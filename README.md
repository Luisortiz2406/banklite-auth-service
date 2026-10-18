# Auth Service (`auth-service`)

Identidad de acceso de BankLite: registro de credenciales, inicio de sesión, tokens JWT, clave dinámica y empleados del panel administrativo.

Parte de **BankLite**, banco digital académico construido con microservicios. Cada
microservicio tiene su propia base de datos y se comunica con los demás por HTTP
(red interna) o por eventos en RabbitMQ.

## Responsabilidad dentro de la arquitectura

Es la puerta de entrada de clientes y empleados. Crea las credenciales del cliente
**solo si kyc-service confirma que su identidad quedó verificada**, emite los JWT
(acceso y renovación) y genera la **clave dinámica** de 6 dígitos que exigen las
operaciones que mueven dinero (transfer, payment, account y card la validan aquí por
la red interna). También administra a los empleados del panel (roles `support`,
`compliance` y `admin`) y cierra sus sesiones al desactivarlos o cambiarles el rol.

**Reglas de negocio principales**

- Contraseñas con bcrypt sobre HMAC-SHA256 con pimienta (`PASSWORD_PEPPER`); bloqueo temporal de la cuenta tras varios intentos fallidos (evento `intento_fallido_login`).
- Correo y celular verificados con código (Gmail API y WhatsApp vía notification-service) antes de crear la cuenta.
- La clave dinámica es un TOTP de 6 dígitos por usuario que cambia cada 60 s (`DYNAMIC_KEY_SECRET`); 5 intentos fallidos seguidos la bloquean 15 minutos.
- Sesiones activas registradas (`sesiones_activas`); el gateway consulta `GET /auth/admin/session` en cada petición del panel.
- Un empleado no puede desactivarse ni cambiar su propio rol o documento; todo queda en `admin_audit`.

**Comunicación con otros servicios**

| | |
|---|---|
| Publica eventos | `usuario_autenticado`, `intento_fallido_login` → notification<br>`account.created` → notification, compliance |
| Consume eventos | — |
| Llama a | kyc-service: estado de identidad y contacto verificado<br>notification-service: OTP por WhatsApp |
| Lo llaman | transfer, payment, account y card: `POST /internal/dynamic-key/verify`<br>api-gateway: sesión del panel<br>api-gateway (rutas `/auth/*`) |
| Integraciones externas | Gmail API (OAuth) para los códigos por correo |

Todo el tráfico externo entra por el **api-gateway** (único servicio público), que
enruta por prefijo (`/auth`), aplica CORS y límite de peticiones, y bloquea las
rutas internas.

## Tecnologías

- Node.js 20, NestJS 10 y TypeScript
- PostgreSQL con TypeORM (`synchronize: true`: las tablas se crean desde las entidades)
- RabbitMQ (amqplib): exchange `banklite.events`, outbox, reintentos y DLQ
- JWT (`@nestjs/jwt`) y `class-validator` para validar todo lo que entra
- Docker (imagen `node:20-alpine`) y despliegue en Railway

## Base de datos (`auth_db`)

| Tabla | Contenido |
|---|---|
| `usuarios_auth` | Credenciales del cliente (hash de contraseña, estado, intentos). |
| `sesiones_activas` | Tokens de renovación vigentes por sesión. |
| `email_verifications` | Códigos de verificación de correo. |
| `phone_verifications` | Verificación del celular por WhatsApp. |
| `password_reset_challenges` | Recuperación de contraseña. |
| `staff_users` | Empleados del panel (rol, estado, `sessions_valid_after`). |
| `admin_audit` | Bitácora de acciones del panel en este servicio (quién, rol, qué y cuándo). |
| `event_outbox` | Outbox de eventos (se publica en RabbitMQ con un relevo). |

En `database/`:

| Archivo | Qué es |
|---|---|
| `schema.sql` | Esquema (tablas, índices, restricciones), generado con `pg_dump --schema-only` desde la base que crea TypeORM. |
| `seed.sql` | Datos de ejemplo de un escenario de demo compartido por todos los servicios (clientes ficticios Ana y Carlos, con los mismos UUID en todas las bases). |
| `backup.sql` | Respaldo completo (esquema + datos de ejemplo) listo para restaurar. |

Restaurar en una base vacía:

```bash
createdb auth_db
psql "postgres://usuario:clave@localhost:5432/auth_db" -f database/backup.sql
# o, por partes:
psql "$DATABASE_URL" -f database/schema.sql -f database/seed.sql
```

Si se arranca el servicio con una base vacía, TypeORM crea las tablas solo.

## Instalación y ejecución

Requisitos: Node.js 20, PostgreSQL 16, RabbitMQ 3.

```bash
npm ci
cp .env.example .env     # completa los secretos (ver abajo)
npm run start:dev        # desarrollo, recarga al guardar
# producción:
npm run build && npm run start:prod
```

Con Docker:

```bash
docker build -t banklite-auth-service .
docker run --env-file .env -p 3001:3001 banklite-auth-service
```

El sistema completo (los 12 servicios, Postgres, RabbitMQ y el gateway) se levanta
desde el repositorio principal con `docker compose up -d --build`.

Comprobar: `curl http://localhost:3001/health`

## Endpoints principales

A través del gateway las rutas son las mismas (`http://localhost:8080/auth/...`).

### Públicos (sin sesión)

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/auth/admin/login` | Inicio de sesión de un empleado → token del panel. |
| POST | `/auth/register` | Crea usuario y contraseña del cliente cuya identidad ya verificó KYC. |
| POST | `/auth/username/check` | ¿El nombre de usuario está disponible? |
| POST | `/auth/email/check` | ¿El correo ya está registrado? |
| POST | `/auth/email/send` | Envía el código de verificación al correo. |
| POST | `/auth/email/verify` | Verifica el código del correo. |
| POST | `/auth/phone/check` | ¿El celular ya está registrado? |
| POST | `/auth/whatsapp/send` | Envía el código por WhatsApp. |
| POST | `/auth/whatsapp/verify` | Verifica el código de WhatsApp. |
| POST | `/auth/verification-status` | Estado de las verificaciones del registro en curso. |
| POST | `/auth/login` | Inicio de sesión (usuario o correo + contraseña) → tokens de acceso y renovación. |
| POST | `/auth/password-recovery/send` | Envía el código para recuperar la contraseña. |
| POST | `/auth/password-recovery/reset` | Cambia la contraseña con el código. |
| POST | `/auth/refresh-token` | Renueva el token de acceso. |
| GET | `/health` | Estado del servicio y de su base (`SELECT 1`); responde 503 con `status: down` si la base no contesta. |

### Del cliente (`Authorization: Bearer <token de acceso>`)

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/auth/dynamic-key` | Clave dinámica vigente del usuario de la sesión. |

### Panel administrativo (`Authorization: Bearer <token de empleado>`; el gateway además valida la sesión)

| Método | Ruta | Roles | Descripción |
|---|---|---|---|
| GET | `/auth/admin/me` | cualquier empleado | Datos del empleado de la sesión. |
| GET | `/auth/admin/session` | cualquier empleado | ¿La sesión del panel sigue vigente? (lo consulta el gateway). |
| POST | `/auth/admin/me/password` | cualquier empleado | El empleado cambia su propia contraseña. |
| GET | `/auth/admin/staff` | admin | Lista de empleados. |
| POST | `/auth/admin/staff` | admin | Crea un empleado con su rol. |
| PATCH | `/auth/admin/staff/:id` | admin | Cambia rol o estado de un empleado (cierra sus sesiones). |
| GET | `/auth/admin/customers` | cualquier empleado | Busca clientes. |
| GET | `/auth/admin/customers/:idUser` | cualquier empleado | Ficha de acceso de un cliente. |
| POST | `/auth/admin/customers/:idUser/disable` | admin | Bloquea el acceso de un cliente. |
| POST | `/auth/admin/customers/:idUser/enable` | admin | Reactiva el acceso de un cliente. |
| GET | `/auth/admin/audit` | cualquier empleado | Bitácora de acciones del panel en este servicio (quién, rol, qué y cuándo). |
| GET | `/auth/admin/outbox` | cualquier empleado | Eventos del outbox (pendientes y publicados). |

### Internos (solo red privada, `x-internal-key`; el gateway responde 404 desde afuera)

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/internal/dynamic-key/verify` | Valida la clave dinámica de un usuario (la llaman los servicios que mueven dinero). |

## Variables de entorno

Ver `.env.example`. Los secretos se generan con
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` (uno distinto
por variable). El servicio **no arranca** si un secreto falta, es corto, es un valor de
ejemplo o se repite entre dos variables (`src/config/env.validation.ts`). En Railway
todas se configuran como variables del servicio, nunca en el código.

| Variable | Obligatoria | Ejemplo / por defecto | Para qué sirve |
|---|---|---|---|
| `NODE_ENV` | No | `development` | `development` en local; `production` en Railway (lo fija el Dockerfile). |
| `PORT` | No | `3001` | Puerto HTTP del servicio. |
| `DATABASE_URL` | **Sí** (no arranca sin ella) | `postgres://auth_svc:<DB_PASSWORD_AUTH>@localhost:5432/auth_db` | Conexión a PostgreSQL de **su** base (rol propio, sin acceso a las demás). |
| `JWT_SECRET` | **Sí** (no arranca sin ella) | — | Firma de los JWT de clientes (el mismo valor que en auth-service). |
| `STAFF_JWT_SECRET` | **Sí** (no arranca sin ella) | — | Firma de los JWT de empleados del panel (el mismo que en auth-service; distinto de JWT_SECRET). |
| `DYNAMIC_KEY_SECRET` | **Sí** (no arranca sin ella) | — | Semilla HMAC de la clave dinámica de 6 dígitos. |
| `PASSWORD_PEPPER` | **Sí** (no arranca sin ella) | — | Pimienta que se suma a las contraseñas antes de bcrypt. |
| `JWT_ACCESS_EXPIRES_IN` | No | `15m` | Duración del token de acceso del cliente. |
| `JWT_REFRESH_EXPIRES_IN` | No | `7d` | Duración del token de renovación. |
| `RABBITMQ_URL` | No | `amqp://banklite:<RABBITMQ_PASSWORD>@localhost:5672` | Conexión a RabbitMQ. Sin ella los eventos quedan en el outbox (o no se consumen). |
| `RABBITMQ_EXCHANGE` | No | `banklite.events` | Exchange topic de eventos (`banklite.events`). |
| `KYC_SERVICE_URL` | Sí | `http://localhost:3003` | URL interna de kyc-service. |
| `INTERNAL_API_KEY` | **Sí** (no arranca sin ella) | — | Clave interna **propia** de este servicio; la manda en `x-internal-key` al llamar a otros. |
| `INTERNAL_TRUSTED_KEYS` | **Sí** (no arranca sin ella) | `transfer:<clave-de-transfer>` | Claves internas que acepta, `servicio:clave,servicio:clave` (ver `InternalKeyGuard`). |
| `NOTIFICATION_SERVICE_URL` | Sí | `http://localhost:3005` | URL interna de notification-service. |
| `GMAIL_CLIENT_ID` | Sí | — | OAuth de Gmail API (envío de correos). |
| `GMAIL_CLIENT_SECRET` | Sí | — | OAuth de Gmail API. |
| `GMAIL_REFRESH_TOKEN` | Sí | — | Refresh token de la cuenta remitente. |
| `GMAIL_SENDER` | Sí | — | Correo remitente. |
| `ADMIN_BOOTSTRAP_USERNAME` | No | — | Usuario del primer administrador (se crea al arrancar si no hay empleados). |
| `ADMIN_BOOTSTRAP_PASSWORD` | No | — | Contraseña del primer administrador (12+ caracteres). |
| `STAFF_JWT_EXPIRES_IN` | No | `8h` | Duración de la sesión de un empleado. |
| `HTTP_READ_RETRIES` | No | `1` | Reintentos de las lecturas (GET) a otros servicios; las escrituras no se reintentan. |

## Primer administrador

Al arrancar, si no hay empleados, se crea un administrador con
`ADMIN_BOOTSTRAP_USERNAME` / `ADMIN_BOOTSTRAP_PASSWORD`. Para registrar el documento
del primer administrador se usa el script de consola `scripts/admin/registrar-documento-admin`
del repositorio principal (queda en la auditoría y no sobrescribe uno existente).
## Pruebas

```bash
npm test
```

## Despliegue

Desplegado en Railway (raíz del servicio: esta carpeta, `railway.json` con
`healthcheckPath: /health`). El servicio no tiene dominio público propio: se accede
por el gateway.

- Estado del servicio y de su base: https://api-gateway-production-dd7f.up.railway.app/health (entrada `auth-service`: `status` y `database` deben estar en `ok`)
- Rutas de este servicio: `https://api-gateway-production-dd7f.up.railway.app/auth/...`
- Aplicación web: https://frontend-production-eff3c.up.railway.app

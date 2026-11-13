# Auth Service (`auth-service`)

[![Despliegue](https://github.com/Luisortiz2406/banklite-auth-service/actions/workflows/deploy.yml/badge.svg?branch=main)](https://github.com/Luisortiz2406/banklite-auth-service/actions/workflows/deploy.yml)

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
| Llama a | kyc-service: estado de identidad y contacto verificado<br>notification-service: OTP por WhatsApp<br>fraud-service: reporte de cada inicio de sesión con la IP del cliente (`POST /internal/fraud/logins`) |
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

**Autorización de datos (marca `cons`)**

El token de acceso del cliente lleva `cons: true` solo si aceptó las versiones vigentes de la política de privacidad y los términos. Se calcula al iniciar sesión, al renovar el token y al aceptar, así que si cambia la versión se vuelve a pedir. El api-gateway no deja operar a un cliente sin esa marca; los empleados (`type: staff`) no se ven afectados. Nunca se rellenan aceptaciones automáticamente: cada cliente acepta él mismo, en el registro o en el modal después de iniciar sesión.

## Base de datos (`auth_db`)

| Tabla | Contenido |
|---|---|
| `usuarios_auth` | Credenciales del cliente (hash de contraseña, estado, intentos). `closed_at`: fecha en que el cliente canceló su cuenta; la fila no se borra (conservación 10 años, referencial: Código de Comercio). |
| `cierre_challenges` | Cancelación en curso: cuándo dio la clave (vale 10 min para el código), intentos fallidos de clave y de código y bloqueo de 15 min tras 5. |
| `consentimientos` | Prueba de la autorización (Ley 1581): documento (`privacidad`, `terminos`), versión aceptada y `aceptado_en` (lo pone el servidor). Sin IP ni datos del navegador. Una fila por documento y versión. |
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
| POST | `/auth/register` | Crea usuario y contraseña del cliente cuya identidad ya verificó KYC. Exige `politicaVersion` y guarda en la misma transacción la aceptación de la política de privacidad y de los términos. Si falta, tiene otro formato o no es la vigente (`POLITICA_PRIVACIDAD_VIGENTE` en `src/auth/consentimientos.ts`), responde 400 con «La política de privacidad se actualizó. Recarga la página, revísala y acéptala de nuevo.» y no crea nada. |
| GET | `/auth/consentimientos/estado` | Con el token del cliente: si aceptó las versiones vigentes de la política de privacidad y los términos (`vigente`), cuáles y cuándo. |
| POST | `/auth/consentimientos` | `{politicaVersion}` con el token del cliente: guarda la aceptación (fecha del servidor, sin IP; idempotente) y devuelve un token de acceso nuevo con `cons: true`. Si la aceptación es nueva, recién ahí se reporta la sesión a fraud-service. Versión no vigente → 400 con el mensaje amable. |
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
| POST | `/auth/cierre/iniciar` | Cancelar la cuenta, paso 1: `{password}`. Con la clave correcta envía un código por WhatsApp al celular verificado y devuelve el celular enmascarado. Clave incorrecta → 401; 5 seguidas → 429 por 15 min. |
| POST | `/auth/cierre/confirmar` | Paso 2: `{codigo}` (dentro de los 10 min siguientes a la clave). Devuelve el **ticket de cierre** (`expiraEnSegundos: 300`), que el frontend entrega a account-service con la palabra «CANCELAR». Un ticket por clave + código; 5 códigos errados → 429. |

### Panel administrativo (`Authorization: Bearer <token de empleado>`; el gateway además valida la sesión)

| Método | Ruta | Roles | Descripción |
|---|---|---|---|
| GET | `/auth/admin/me` | cualquier empleado | Datos del empleado de la sesión. |
| GET | `/auth/admin/session` | cualquier empleado | ¿La sesión del panel sigue vigente? (lo consulta el gateway). |
| POST | `/auth/admin/me/password` | cualquier empleado | El empleado cambia su propia contraseña. |
| GET | `/auth/admin/staff` | admin | Lista de empleados. |
| POST | `/auth/admin/staff` | admin | Crea un empleado con su rol. |
| PATCH | `/auth/admin/staff/:id` | admin | Cambia rol o estado de un empleado (cierra sus sesiones). |
| GET | `/auth/admin/customers` | cualquier empleado | Busca clientes (`?q=` correo o ID; `?status=` `active`, `locked`, `disabled` o `closed`). Cada cliente cae en un solo estado, el mismo de su `access`: cancelado > suspendido > bloqueo temporal > activo (los que cancelaron solo salen en `closed`). |
| GET | `/auth/admin/customers/:idUser` | cualquier empleado | Ficha de acceso de un cliente. |
| GET | `/auth/admin/customers/:idUser/consentimientos` | compliance, admin | Autorización de datos del cliente: versión vigente aceptada (o ninguna: cuenta anterior) e historial. Queda en la auditoría. |
| POST | `/auth/admin/customers/:idUser/disable` | admin | Bloquea el acceso de un cliente. |
| POST | `/auth/admin/customers/:idUser/enable` | admin | Reactiva el acceso de un cliente. |
| GET | `/auth/admin/audit` | cualquier empleado | Bitácora de acciones del panel en este servicio (quién, rol, qué y cuándo). |
| GET | `/auth/admin/outbox` | cualquier empleado | Eventos del outbox (pendientes y publicados). |

### Internos (solo red privada, `x-internal-key`; el gateway responde 404 desde afuera)

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/internal/dynamic-key/verify` | Valida la clave dinámica de un usuario (la llaman los servicios que mueven dinero). |
| POST | `/internal/auth/cierre-acceso` | Solo account-service (clave `account`), ya cerrada la cuenta: `{idUser, cerradaEn?}` marca `closed_at`, revoca **todas** las sesiones y bloquea el inicio de sesión («Tu cuenta fue cancelada el …») y la renovación del token. Idempotente: account-service la reintenta hasta que responda. |

**Ticket de cierre.** JWT HS256 firmado con `CLOSURE_TICKET_SECRET` (no con `JWT_SECRET`), `type: closure_ticket`, `aud: account-service`, `jti` único y 5 minutos de vida. Un token de acceso nunca sirve como ticket ni un ticket como token de acceso (otro secreto y otro tipo; lo prueba `cierre-ticket.spec.ts`). account-service lo verifica y guarda el `jti` para que sea de un solo uso.

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
| `METRICS_PORT` | No | `9100` | Puerto de `GET /metrics` (Prometheus), solo para la red privada; **no** es el puerto público (`PORT`). `off` lo apaga. |
| `DATABASE_URL` | **Sí** (no arranca sin ella) | `postgres://auth_svc:<DB_PASSWORD_AUTH>@localhost:5432/auth_db` | Conexión a PostgreSQL de **su** base (rol propio, sin acceso a las demás). |
| `JWT_SECRET` | **Sí** (no arranca sin ella) | — | Firma de los JWT de clientes (el mismo valor que en auth-service). |
| `STAFF_JWT_SECRET` | **Sí** (no arranca sin ella) | — | Firma de los JWT de empleados del panel (el mismo que en auth-service; distinto de JWT_SECRET). |
| `DYNAMIC_KEY_SECRET` | **Sí** (no arranca sin ella) | — | Semilla HMAC de la clave dinámica de 6 dígitos. |
| `PASSWORD_PEPPER` | **Sí** (no arranca sin ella) | — | Pimienta que se suma a las contraseñas antes de bcrypt. |
| `CLOSURE_TICKET_SECRET` | Para cancelar cuentas | — | Firma del ticket de cierre (`openssl rand -hex 32`). Distinto de los demás secretos; si está, debe tener 32+ caracteres sin espacios ni comillas o el servicio no arranca. El mismo valor en account-service (`${{auth-service.CLOSURE_TICKET_SECRET}}` en Railway). Vacía: «Cancelar mi cuenta» responde 503. |
| `JWT_ACCESS_EXPIRES_IN` | No | `15m` | Duración del token de acceso del cliente. |
| `JWT_REFRESH_EXPIRES_IN` | No | `7d` | Duración del token de renovación. |
| `RABBITMQ_URL` | No | `amqp://banklite:<RABBITMQ_PASSWORD>@localhost:5672` | Conexión a RabbitMQ. Sin ella los eventos quedan en el outbox (o no se consumen). |
| `RABBITMQ_EXCHANGE` | No | `banklite.events` | Exchange topic de eventos (`banklite.events`). |
| `KYC_SERVICE_URL` | Sí | `http://localhost:3003` | URL interna de kyc-service. |
| `INTERNAL_API_KEY` | **Sí** (no arranca sin ella) | — | Clave interna **propia** de este servicio; la manda en `x-internal-key` al llamar a otros. |
| `INTERNAL_TRUSTED_KEYS` | **Sí** (no arranca sin ella) | `transfer:<clave-de-transfer>` | Claves internas que acepta, `servicio:clave,servicio:clave` (ver `InternalKeyGuard`). |
| `NOTIFICATION_SERVICE_URL` | Sí | `http://localhost:3005` | URL interna de notification-service. |
| `FRAUD_SERVICE_URL` | No | `http://localhost:3009` | URL interna de fraud-service. Si está, cada inicio de sesión (exitoso o fallido) **de un cliente con la autorización vigente** se le reporta con la IP del cliente (sin autorización la IP no se procesa; la sesión se reporta al aceptar) (`x-client-ip` del gateway), sin esperar la respuesta: nunca frena ni rompe el inicio de sesión. La IP no se guarda en auth ni se escribe en los logs. Vacía: no se reporta. |
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
npm test   # con TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres para las de base
```

Con base: el registro guarda la cuenta, la aceptación de la política y el evento juntos o no guarda nada; versión distinta de la vigente o ausente → 400 con el mensaje amable, sin crear nada.

**Clave dinámica** (`dynamic-key.service.spec.ts`): el código es el TOTP de 6 dígitos de ese usuario y minuto, comparado con una implementación independiente del RFC 4226/6238; se acepta el del minuto anterior pero no el de dos minutos atrás ni el siguiente; 5 fallos seguidos bloquean 15 minutos, el bloqueo de un usuario no afecta a otro y el servicio no arranca sin `DYNAMIC_KEY_SECRET`.

**Sesión y recuperación** (`auth.service.spec.ts`, con base): 5 claves incorrectas bloquean 30 minutos; una cuenta cancelada o suspendida por el banco no entra (y solo se les dice con la clave correcta); un refresh revocado, vencido o de una cuenta suspendida no renueva; el registro exige correo, teléfono e identidad verificados; la recuperación por correo o WhatsApp se bloquea tras 3 intentos fallidos y cierra las sesiones al cambiar la clave. También se prueban el hash con pepper, los clientes de KYC y notificaciones, el controlador, los guards, `/health` y la validación de configuración.

**Cobertura:** el pipeline la muestra en el resumen de cada corrida y exige un mínimo de 70 % de líneas y 50 % de ramas (`umbral-lineas` y `umbral-ramas` en `deploy.yml`). Hoy está en 74,3 % de líneas y 65,1 % de ramas.

## Despliegue

Lo despliega **GitHub Actions** (`.github/workflows/deploy.yml`, que usa el workflow
reutilizable de [banklite-pipelines](https://github.com/Luisortiz2406/banklite-pipelines)):

1. **test**: lint, formato, build y pruebas con Postgres (también en cada pull request).
2. **docker** (solo `main`): imagen en GHCR `ghcr.io/luisortiz2406/banklite-auth-service`,
   etiquetada con el SHA del commit y `latest` (se guardan las últimas 5).
3. **deploy** (solo `main`): `railway up --ci` sube el commit a Railway, que lo
   construye con el `Dockerfile` y aplica `railway.json` (health check en `/health`);
   el job espera a que el despliegue quede activo.

El repositorio está desconectado del autodeploy de Railway: un push a `main` despliega
solo a través de este pipeline, y únicamente si las pruebas pasan. Rollback: panel de
Railway → *Deployments* → versión anterior → *Rollback*. El servicio no tiene dominio público propio: se accede
por el gateway.

- Estado del servicio y de su base: [https://api-gateway-production-dd7f.up.railway.app/health](https://api-gateway-production-dd7f.up.railway.app/health) (entrada `auth-service`: `status` y `database` deben estar en `ok`)
- Rutas de este servicio: `https://api-gateway-production-dd7f.up.railway.app/auth/...`
- Aplicación web: https://frontend-production-eff3c.up.railway.app

## Repositorios relacionados

Servicios de BankLite con los que se comunica este. **Llama a** / **Lo llama**: HTTP
por la red interna; **Recibe** / **Envía**: eventos en RabbitMQ. Cada uno vive y se
despliega desde su propio repositorio.

| Repositorio | Relación con este servicio |
|---|---|
| [banklite-api-gateway](https://github.com/Luisortiz2406/banklite-api-gateway) | **Lo llama:** punto de entrada público, le enruta las rutas de este servicio |
| [banklite-kyc-service](https://github.com/Luisortiz2406/banklite-kyc-service) | **Llama a:** estado de identidad y contacto verificado |
| [banklite-fraud-service](https://github.com/Luisortiz2406/banklite-fraud-service) | **Llama a:** reporta cada inicio de sesión con la IP del cliente para la geolocalización (clave interna `auth`) |
| [banklite-notification-service](https://github.com/Luisortiz2406/banklite-notification-service) | **Llama a:** OTP por WhatsApp y correos<br>**Envía:** `usuario_autenticado`, `intento_fallido_login`, `account.created` |
| [banklite-compliance-service](https://github.com/Luisortiz2406/banklite-compliance-service) | **Envía:** `account.created` |
| [banklite-account-service](https://github.com/Luisortiz2406/banklite-account-service) | **Lo llama:** verificación de la clave dinámica (llaves Bre-B); cierre del acceso al cancelar la cuenta (`POST /internal/auth/cierre-acceso`)<br>**Comparten:** `CLOSURE_TICKET_SECRET` (auth firma el ticket de cierre, account lo verifica) |
| [banklite-transfer-service](https://github.com/Luisortiz2406/banklite-transfer-service) | **Lo llama:** verificación de la clave dinámica |
| [banklite-payment-service](https://github.com/Luisortiz2406/banklite-payment-service) | **Lo llama:** verificación de la clave dinámica |
| [banklite-card-service](https://github.com/Luisortiz2406/banklite-card-service) | **Lo llama:** verificación de la clave dinámica |

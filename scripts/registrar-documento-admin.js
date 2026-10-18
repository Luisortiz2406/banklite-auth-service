/**
 * Registra el documento de identidad de un ADMINISTRADOR que todavía no lo tiene.
 * Es para el primer administrador: en el panel nadie puede registrar ni cambiar
 * su propio documento, y sin documento no se pueden aprobar verificaciones.
 *
 * - Solo guarda la huella (staffDocHash, la misma que usa el panel), nunca el número.
 * - Se niega a sobrescribir un documento ya registrado y a usar uno que ya tenga
 *   otro empleado.
 * - Queda en admin_audit de auth-service (acción staff.document_registered).
 *
 * Se ejecuta dentro del contenedor de auth-service (usa DATABASE_URL y
 * STAFF_JWT_SECRET del servicio) con scripts/admin/registrar-documento-admin.sh.
 * Uso directo: node scripts/registrar-documento-admin.js --usuario <usuario>
 */
const { randomUUID } = require('crypto');
const readline = require('readline');
const { Client } = require('pg');
const { staffDocHash } = require('../dist/common/staff/staff-doc-hash');

const DOCUMENT_RULE = /^[0-9A-Za-z][0-9A-Za-z.\- ]{3,18}[0-9A-Za-z]$/;

function fail(message) {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

// Una sola interfaz para todas las preguntas (si la entrada llega por tubería,
// una segunda interfaz no recibiría nada). Con hidden no se muestra lo que se escribe.
const tty = !!process.stdin.isTTY;
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: tty });
let muted = false;
const write = rl._writeToOutput.bind(rl);
rl._writeToOutput = (text) => {
  if (!muted) write(text);
};
// Las líneas que llegan antes de preguntar (entrada por tubería) esperan en `lines`;
// si la entrada se acaba, las preguntas pendientes reciben '' y fallan la validación.
const lines = [];
const pending = [];
let ended = false;
rl.on('line', (line) => (pending.length ? pending.shift()(line.trim()) : lines.push(line.trim())));
rl.on('close', () => {
  ended = true;
  while (pending.length) pending.shift()('');
});

function ask(question, hidden = false) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    muted = hidden && tty;
    const answer = (value) => {
      if (muted) process.stdout.write('\n');
      muted = false;
      resolve(value);
    };
    if (lines.length) answer(lines.shift());
    else if (ended) answer('');
    else pending.push(answer);
  });
}

async function main() {
  const username = (argValue('--usuario') || '').trim().toLowerCase();
  if (!username) fail('Indica el usuario del administrador: --usuario <usuario>');
  const secret = process.env.STAFF_JWT_SECRET;
  if (!secret) fail('Falta STAFF_JWT_SECRET: ejecuta el script dentro del contenedor de auth-service.');
  if (!process.env.DATABASE_URL) fail('Falta DATABASE_URL: ejecuta el script dentro del contenedor de auth-service.');

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const { rows } = await client.query(
      'SELECT id, role, active, documento_hash FROM staff_users WHERE username = $1',
      [username],
    );
    const staff = rows[0];
    if (!staff) fail(`No existe un empleado con el usuario '${username}'.`);
    if (staff.role !== 'admin') {
      fail(`'${username}' no es administrador: su documento lo registra un administrador desde el panel (Empleados).`);
    }
    if (staff.documento_hash) fail(`'${username}' ya tiene un documento registrado. Este script no lo sobrescribe.`);

    console.log(`Registrar el documento del administrador '${username}'.`);
    const operador = await ask('Tu nombre (quién ejecuta el script, queda en la auditoría): ');
    if (operador.length < 3) fail('Escribe tu nombre (mínimo 3 caracteres).');
    const documento = await ask('Número de documento del administrador (no se muestra): ', true);
    if (!DOCUMENT_RULE.test(documento)) fail('El documento debe tener entre 5 y 20 caracteres (números y letras).');
    const confirmacion = await ask('Repite el número de documento: ', true);
    if (confirmacion !== documento) fail('Los documentos no coinciden. No se registró nada.');

    const hash = staffDocHash(secret, documento);
    await client.query('BEGIN');
    // Se vuelve a leer con bloqueo: si alguien lo registró mientras tanto, no se sobrescribe.
    const locked = await client.query('SELECT documento_hash FROM staff_users WHERE id = $1 FOR UPDATE', [staff.id]);
    if (locked.rows[0].documento_hash) {
      await client.query('ROLLBACK');
      fail(`'${username}' ya tiene un documento registrado. Este script no lo sobrescribe.`);
    }
    const repetido = await client.query('SELECT username FROM staff_users WHERE documento_hash = $1 AND id <> $2', [
      hash,
      staff.id,
    ]);
    if (repetido.rowCount) {
      await client.query('ROLLBACK');
      fail('Ese documento ya está registrado para otro empleado.');
    }
    await client.query('UPDATE staff_users SET documento_hash = $1, updated_at = now() WHERE id = $2', [
      hash,
      staff.id,
    ]);
    await client.query(
      `INSERT INTO admin_audit (id, staff_id, staff_username, staff_role, action, target_type, target_id, reason, details, created_at)
       VALUES ($1, 'consola', 'consola', NULL, 'staff.document_registered', 'staff', $2, $3, $4, now())`,
      [
        randomUUID(),
        staff.id,
        'Registro del documento del administrador por consola (scripts/admin/registrar-documento-admin.sh)',
        JSON.stringify({ username, operador }),
      ],
    );
    await client.query('COMMIT');
    console.log(`\n✓ Documento registrado para '${username}' y anotado en la auditoría.`);
    console.log('  Debe volver a ingresar al panel para que su sesión lo tenga en cuenta.');
  } finally {
    rl.close();
    await client.end();
  }
}

main().catch((err) => fail(err.message));

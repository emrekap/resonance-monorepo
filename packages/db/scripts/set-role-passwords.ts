/**
 * Sets the login passwords for `app_user` and `app_service`.
 *
 * The security migration creates those roles but cannot set their passwords —
 * a committed migration must not contain secrets. This reads the passwords back
 * out of the connection strings in `.env`, so `.env` stays the single source of
 * truth, and applies them over the admin connection.
 *
 *   bun run scripts/set-role-passwords.ts
 *
 * Re-run it whenever you rotate a password in `.env`.
 */
import 'dotenv/config';
import { Client } from 'pg';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — copy .env.example to .env`);
  return value;
}

/** Pulls the password out of a postgres:// URL. */
function passwordFrom(urlName: string): string {
  const { password } = new URL(required(urlName));
  if (!password) throw new Error(`${urlName} has no password component`);
  return decodeURIComponent(password);
}

/** ALTER ROLE ... PASSWORD takes no bind parameters, so quote it ourselves. */
function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

const roles = [
  { role: 'app_user', password: passwordFrom('APP_USER_DATABASE_URL') },
  { role: 'app_service', password: passwordFrom('APP_SERVICE_DATABASE_URL') },
];

const admin = new Client({ connectionString: required('DIRECT_DATABASE_URL') });
await admin.connect();

try {
  for (const { role, password } of roles) {
    // `role` comes from the fixed list above, never from input.
    await admin.query(`ALTER ROLE ${role} WITH LOGIN PASSWORD ${sqlLiteral(password)}`);
    console.log(`✓ password set for ${role}`);
  }
} finally {
  await admin.end();
}

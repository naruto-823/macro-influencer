import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import pg from 'pg';

const scrypt = promisify(scryptCallback);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function passwordHash(password: string, salt: string): Promise<string> {
  return ((await scrypt(password, salt, 64)) as Buffer).toString('hex');
}

export async function initializeUsers(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY,
      username VARCHAR(32) NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  const username = process.env.AUTH_USERNAME;
  const password = process.env.AUTH_PASSWORD;
  if (username && password) {
    const existing = await pool.query('SELECT 1 FROM users WHERE username = $1', [username]);
    if (!existing.rowCount) await createUser(username, password);
  }
}

export async function createUser(username: string, password: string): Promise<string> {
  if (!/^[a-zA-Z0-9_-]{3,32}$/.test(username))
    throw new Error('账号需为 3-32 位字母、数字、下划线或横线');
  if (password.length < 10 || password.length > 128) throw new Error('密码至少 10 位');
  const id = randomUUID();
  const salt = randomBytes(24).toString('hex');
  const hash = await passwordHash(password, salt);
  try {
    await pool.query(
      'INSERT INTO users (id, username, password_hash, password_salt) VALUES ($1, $2, $3, $4)',
      [id, username, hash, salt],
    );
    return id;
  } catch (error) {
    if ((error as { code?: string }).code === '23505') throw new Error('账号已存在');
    throw error;
  }
}

export async function authenticateUser(
  username: string,
  password: string,
): Promise<string | undefined> {
  const result = await pool.query<{
    id: string;
    password_hash: string;
    password_salt: string;
  }>('SELECT id, password_hash, password_salt FROM users WHERE username = $1', [username]);
  const user = result.rows[0];
  if (!user) return undefined;
  const actual = Buffer.from(await passwordHash(password, user.password_salt));
  const expected = Buffer.from(user.password_hash);
  return actual.length === expected.length && timingSafeEqual(actual, expected)
    ? user.id
    : undefined;
}

import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { type PersonaPack, definePersona } from '../persona/persona-pack.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

export async function initializeAccounts(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS personas (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      display_name VARCHAR(80) NOT NULL,
      profile JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, display_name)
    )
  `);
}

export async function userIdForUsername(username: string): Promise<string | undefined> {
  const result = await pool.query<{ id: string }>('SELECT id FROM users WHERE username = $1', [
    username,
  ]);
  return result.rows[0]?.id;
}

export async function listAccounts(
  userId: string,
): Promise<Array<{ id: string; displayName: string }>> {
  const result = await pool.query<{ id: string; display_name: string }>(
    'SELECT id, display_name FROM personas WHERE user_id = $1 ORDER BY created_at',
    [userId],
  );
  return result.rows.map((row) => ({ id: row.id, displayName: row.display_name }));
}

export async function getAccount(userId: string, id: string): Promise<PersonaPack | undefined> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
    return undefined;
  const result = await pool.query<{ profile: PersonaPack }>(
    'SELECT profile FROM personas WHERE id = $1 AND user_id = $2',
    [id, userId],
  );
  const profile = result.rows[0]?.profile;
  return profile ? definePersona(profile) : undefined;
}

export async function importAccount(
  userId: string,
  input: Omit<PersonaPack, 'id'> & { sourceUrl?: string },
): Promise<{ id: string; displayName: string }> {
  const id = randomUUID();
  const profile = definePersona({ ...input, id: `account-${id}` });
  try {
    await pool.query(
      'INSERT INTO personas (id, user_id, display_name, profile) VALUES ($1, $2, $3, $4)',
      [id, userId, profile.displayName, profile],
    );
  } catch (error) {
    if ((error as { code?: string }).code === '23505') throw new Error('该账号已经导入');
    throw error;
  }
  return { id, displayName: profile.displayName };
}

export async function ensureAccount(userId: string, profile: PersonaPack): Promise<void> {
  const exists = await pool.query(
    'SELECT 1 FROM personas WHERE user_id = $1 AND display_name = $2',
    [userId, profile.displayName],
  );
  if (!exists.rowCount) await importAccount(userId, profile);
}

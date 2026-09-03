// CEN-55 — AES-at-rest for storageState session files (.enc).
// Key precedence: env AGENCY_PROFILE_KEY (64 hex chars = 32 bytes) > local key file (gitignored,
// auto-generated). For real/shared deployment, set AGENCY_PROFILE_KEY in .env (floor: never commit).
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const MAGIC = 'CEN55v1'; // format tag: MAGIC | iv(12) | tag(16) | ciphertext

function loadKey(storeRoot: string): Buffer {
  const env = process.env.AGENCY_PROFILE_KEY;
  if (env && /^[0-9a-fA-F]{64}$/.test(env)) return Buffer.from(env, 'hex');
  const keyFile = join(storeRoot, '.session-key');
  if (existsSync(keyFile)) return Buffer.from(readFileSync(keyFile, 'utf-8').trim(), 'hex');
  const key = randomBytes(32);
  writeFileSync(keyFile, key.toString('hex'), { mode: 0o600 });
  return key;
}

export function encryptJSON(storeRoot: string, obj: unknown): Buffer {
  const key = loadKey(storeRoot);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const pt = Buffer.from(JSON.stringify(obj), 'utf-8');
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from(MAGIC, 'utf-8'), iv, tag, ct]);
}

export function decryptJSON<T = unknown>(storeRoot: string, blob: Buffer): T {
  const key = loadKey(storeRoot);
  const magic = blob.subarray(0, MAGIC.length).toString('utf-8');
  if (magic !== MAGIC) throw new Error(`bad session file magic: ${magic}`);
  let o = MAGIC.length;
  const iv = blob.subarray(o, (o += 12));
  const tag = blob.subarray(o, (o += 16));
  const ct = blob.subarray(o);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(pt.toString('utf-8')) as T;
}

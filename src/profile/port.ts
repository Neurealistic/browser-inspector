// CEN-55 — dynamic CDP port assignment (preserves the CEN-2 formula).
// Deterministic base per key, then linear-probe to the first free port. Persisted per user-data-dir.
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const CLONE_BASE_PORT = 9300;
const RANGE = 600;

function hashKey(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function portListening(p: number): boolean {
  try { execSync(`lsof -nP -iTCP:${p} -sTCP:LISTEN`, { stdio: 'pipe' }); return true; } catch { return false; }
}

export function cdpAlive(p: number): boolean {
  try { execSync(`curl -s --max-time 1 http://localhost:${p}/json/version`, { stdio: 'pipe' }); return true; } catch { return false; }
}

// Assign (or reuse) a free CDP port for a materialized profile dir. `key` = alias name (stable id).
export function assignPort(key: string, userDataDir: string): number {
  const portFile = join(userDataDir, '.cdp-port');
  let port = 0;
  if (existsSync(portFile)) {
    const v = parseInt(readFileSync(portFile, 'utf-8').trim(), 10);
    if (v) port = v;
  }
  // no port yet, or ours died and the slot was reused by someone else
  if (!port || (portListening(port) && !cdpAlive(port))) {
    let p = CLONE_BASE_PORT + (hashKey(key) % RANGE);
    while (portListening(p)) p++; // TOCTOU: caller launches immediately after; acceptable for v1
    port = p;
    try { writeFileSync(portFile, String(port)); } catch { /* best-effort */ }
  }
  return port;
}

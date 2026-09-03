// CEN-55 — builder: materialize a canonical alias into a live, machine-bound browser instance.
// Dual-engine (chromium + firefox). Session is injected via the browser protocol (addCookies +
// localStorage replay) so the TARGET browser re-encrypts cookies with its own local key — we never
// carry OSCrypt/DPAPI ciphertext across machines. Chromium branch also opens a CDP port (CEN-2 model).
import { chromium, firefox } from 'playwright';
import type { BrowserContext } from 'playwright';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { resolve, resolveBinary, clonesRoot, storeRoot } from './store.js';
import { assignPort } from './port.js';
import { decryptJSON } from './crypto.js';
import { readFileSync } from 'fs';
import type { Resolved, Policy } from './types.js';

export interface Instance {
  alias: string;
  engine: string;
  userDataDir: string;
  cdpPort: number | null; // chromium only
  context: BrowserContext;
  close: () => Promise<void>;
}

interface MaterializeOpts { headless?: boolean; root?: string }

function loadSession(sessionPath: string, root: string): { cookies: any[]; origins: any[] } {
  const blob = readFileSync(sessionPath);
  return decryptJSON(root, blob);
}

// Replay a storageState into a live context: cookies straight in, localStorage per-origin.
async function injectSession(ctx: BrowserContext, state: { cookies: any[]; origins: any[] }): Promise<void> {
  if (state.cookies?.length) await ctx.addCookies(state.cookies);
  for (const o of state.origins ?? []) {
    if (!o.localStorage?.length) continue;
    const page = await ctx.newPage();
    try {
      await page.goto(o.origin, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.evaluate((items: { name: string; value: string }[]) => {
        for (const it of items) localStorage.setItem(it.name, it.value);
      }, o.localStorage);
    } finally {
      await page.close();
    }
  }
}

export async function materialize(aliasName: string, opts: MaterializeOpts = {}): Promise<Instance> {
  const root = opts.root ?? storeRoot();
  const r: Resolved = resolve(aliasName, root);
  const binary = resolveBinary(r.os, r.browser, root);
  // Materialized dir + port key on the stable UUID (rename-safe), not the human alias name.
  const userDataDir = join(clonesRoot(root), r.id);
  mkdirSync(userDataDir, { recursive: true });
  const headless = opts.headless ?? true;

  let context: BrowserContext;
  let cdpPort: number | null = null;

  if (r.engine === 'chromium') {
    cdpPort = assignPort(r.id, userDataDir);
    context = await chromium.launchPersistentContext(userDataDir, {
      executablePath: binary,
      headless,
      args: [...r.flags, `--remote-debugging-port=${cdpPort}`, '--no-first-run', '--no-default-browser-check'],
    });
  } else {
    context = await firefox.launchPersistentContext(userDataDir, {
      executablePath: binary,
      headless,
      firefoxUserPrefs: r.prefs as Record<string, string | number | boolean>,
    });
  }

  if (r.sessionPath) {
    try { await injectSession(context, loadSession(r.sessionPath, root)); }
    catch (e) { /* session inject best-effort; a fresh profile is still usable */ console.error(`injectSession warn: ${(e as Error).message}`); }
  }

  return {
    alias: aliasName,
    engine: r.engine,
    userDataDir,
    cdpPort,
    context,
    close: async () => { await context.close(); },
  };
}

// ─── Detached mode (for the long-running browser-inspector MCP) ───────────────
// The MCP spawns a DETACHED chromium and reconnects via connectOverCDP across separate tool calls
// (CEN-2 model). These helpers let it drive the canonical store without owning a Playwright context.

// Resolve an alias to the {binary, profile-dir, cdpPort} the MCP's spawn code needs. Does NOT launch.
export function resolveAliasEntry(aliasName: string, root = storeRoot()): { binary: string; profile: string; cdpPort: number } {
  const r: Resolved = resolve(aliasName, root);
  if (r.engine !== 'chromium') throw new Error(`detached mode is chromium-only; alias "${aliasName}" is ${r.engine}`);
  const binary = resolveBinary(r.os, r.browser, root);
  const userDataDir = join(clonesRoot(root), r.id);
  mkdirSync(userDataDir, { recursive: true });
  const cdpPort = assignPort(r.id, userDataDir);
  return { binary, profile: userDataDir, cdpPort };
}

// Inject the alias's session into an already-running detached chromium over CDP, then disconnect
// (leaves the browser process alive — Playwright didn't spawn it, so close() only drops the connection).
// Returns true if a session was injected. Call once, right after a FRESH launch.
export async function injectDetached(cdpUrl: string, aliasName: string, root = storeRoot()): Promise<boolean> {
  const r: Resolved = resolve(aliasName, root);
  if (!r.sessionPath) return false;
  const state = loadSession(r.sessionPath, root);
  const browser = await chromium.connectOverCDP(cdpUrl);
  try {
    const ctx = browser.contexts()[0] ?? (await browser.newContext());
    await injectSession(ctx, state);
    return true;
  } finally {
    await browser.close(); // disconnect only; detached chrome keeps running
  }
}

// Optional: enforce a Source policy at the network layer (block wins over allow).
function hostMatches(host: string, glob: string): boolean {
  if (glob === host) return true;
  if (glob.startsWith('*.')) { const base = glob.slice(2); return host === base || host.endsWith('.' + base); }
  return false;
}

export async function applyPolicy(ctx: BrowserContext, policy: Policy): Promise<void> {
  if (!policy.allow.length && !policy.block.length) return;
  await ctx.route('**/*', (route) => {
    let host = '';
    try { host = new URL(route.request().url()).hostname; } catch { return route.continue(); }
    if (policy.block.some(g => hostMatches(host, g))) return route.abort();
    if (policy.allow.length && !policy.allow.some(g => hostMatches(host, g))) return route.abort();
    return route.continue();
  });
}

// CEN-55 — canonical store: read/resolve schema, locate the per-machine binary map.
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import type { Source, Alias, Machine, Index, Resolved, Engine } from './types.js';

export function storeRoot(): string {
  return join(process.env.INSPECTOR_HOME ?? process.cwd(), 'canonical');
}

function expand(p: string): string {
  return p.replace(/\$HOME/g, process.env.HOME ?? '').replace(/\$\{HOME\}/g, process.env.HOME ?? '');
}

export function loadIndex(root = storeRoot()): Index {
  return JSON.parse(readFileSync(join(root, 'index.json'), 'utf-8'));
}

export function loadMachine(root = storeRoot()): Machine {
  const idx = loadIndex(root);
  const p = join(root, idx.machine);
  if (!existsSync(p)) throw new Error(`machine config missing: ${p} — copy machine.local.json for this machine (gitignored)`);
  return JSON.parse(readFileSync(p, 'utf-8'));
}

export function listSources(root = storeRoot()): string[] {
  const dir = join(root, loadIndex(root).sources);
  return existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, '')) : [];
}

export function listAliases(root = storeRoot()): string[] {
  const dir = join(root, loadIndex(root).aliases);
  return existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, '')) : [];
}

export function readSource(name: string, root = storeRoot()): Source {
  const p = join(root, loadIndex(root).sources, `${name}.json`);
  if (!existsSync(p)) throw new Error(`unknown source "${name}" — have: ${listSources(root).join(', ')}`);
  return JSON.parse(readFileSync(p, 'utf-8'));
}

export function readAlias(name: string, root = storeRoot()): Alias {
  const p = join(root, loadIndex(root).aliases, `${name}.json`);
  if (!existsSync(p)) throw new Error(`unknown alias "${name}" — have: ${listAliases(root).join(', ')}`);
  return JSON.parse(readFileSync(p, 'utf-8'));
}

export function writeSource(name: string, src: Source, root = storeRoot()): void {
  const dir = join(root, loadIndex(root).sources);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(src, null, 2) + '\n');
}

export function writeAlias(name: string, alias: Alias, root = storeRoot()): void {
  const dir = join(root, loadIndex(root).aliases);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(alias, null, 2) + '\n');
}

export function deleteAlias(name: string, root = storeRoot()): void {
  rmSync(join(root, loadIndex(root).aliases, `${name}.json`), { force: true });
}

export function sessionsDir(root = storeRoot()): string {
  const d = join(root, loadIndex(root).sessions);
  mkdirSync(d, { recursive: true });
  return d;
}

export function clonesRoot(root = storeRoot()): string {
  return expand(loadMachine(root).clonesRoot);
}

export function resolveBinary(os: string, browser: string, root = storeRoot()): string {
  const m = loadMachine(root);
  const path = m.binaries[os as keyof typeof m.binaries]?.[browser];
  if (!path) throw new Error(`no binary for os=${os} browser=${browser} in machine.local.json`);
  const p = expand(path);
  if (!existsSync(p)) throw new Error(`binary path does not exist: ${p}`);
  return p;
}

// Merge src + alias.overlay → the flat Resolved config the builder consumes.
export function resolve(aliasName: string, root = storeRoot()): Resolved {
  const alias = readAlias(aliasName, root);
  const src = readSource(alias.src, root);
  const o = alias.overlay || {};
  const engine: Engine = (o.engine as Engine) ?? src.engine;
  return {
    id: alias.id,
    alias: aliasName,
    engine,
    browser: alias.target.browser,
    os: alias.target.os,
    policy: { ...src.policy, ...(o.policy || {}) },
    prefs: { ...src.prefs, ...(o.prefs || {}) },
    extensions: o.extensions ?? src.extensions,
    fingerprint: { ...src.fingerprint, ...(o.fingerprint || {}) },
    flags: o.flags ?? src.flags,
    sessionPath: alias.session ? join(root, alias.session) : null,
  };
}

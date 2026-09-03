// CEN-55 — CRUD + copy + export/import + session capture verbs over the canonical store.
// These replace effectiveProfile/cloneProfile + browser-profiles.json editing. materialize() lives in builder.
import { writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { randomUUID } from 'crypto';
import { join } from 'path';
import {
  storeRoot, listSources, listAliases, readSource, readAlias, writeSource, writeAlias,
  deleteAlias, resolve, sessionsDir,
} from './store.js';
import { encryptJSON, decryptJSON } from './crypto.js';
import type { Source, Alias } from './types.js';
import type { Instance } from './builder.js';

// ---- READ / LIST ----
export function list(root = storeRoot()) {
  return { sources: listSources(root), aliases: listAliases(root) };
}
export function read(aliasName: string, root = storeRoot()) {
  return { alias: readAlias(aliasName, root), resolved: resolve(aliasName, root) };
}

// ---- CREATE ----
export function createSource(name: string, src: Source, root = storeRoot()): void {
  if (listSources(root).includes(name)) throw new Error(`source "${name}" already exists`);
  writeSource(name, src, root);
}
// id is generated here (a fresh UUID) unless the caller supplies one (e.g. import keeps the logical id).
export function createAlias(name: string, alias: Omit<Alias, 'id'> & { id?: string }, root = storeRoot()): string {
  if (listAliases(root).includes(name)) throw new Error(`alias "${name}" already exists`);
  readSource(alias.src, root); // validate src exists
  const id = alias.id ?? randomUUID();
  writeAlias(name, { overlay: {}, session: null, ...alias, id }, root);
  return id;
}

// ---- UPDATE ----
export function updateAlias(name: string, patch: Partial<Alias>, root = storeRoot()): void {
  writeAlias(name, { ...readAlias(name, root), ...patch }, root);
}

// ---- DELETE (destructive — caller/perm-mode floor must confirm) ----
export function deleteAliasAndProfile(name: string, clonesDir: string, root = storeRoot()): void {
  const a = readAlias(name, root);
  if (a.session) rmSync(join(root, a.session), { force: true });
  rmSync(join(clonesDir, a.id), { recursive: true, force: true }); // materialized dir keyed on UUID
  deleteAlias(name, root);
}

// ---- COPY / DERIVE (src → new alias). Same machine: alias only; materialize builds the dir fresh. ----
export function copyAlias(from: string, to: string, root = storeRoot()): string {
  const a = readAlias(from, root);
  if (listAliases(root).includes(to)) throw new Error(`alias "${to}" already exists`);
  const id = randomUUID(); // a copy is a NEW profile → new identity
  writeAlias(to, { ...a, id, session: null }, root); // derived alias starts session-less
  return id;
}

// ---- SESSION CAPTURE (storageState → encrypted .enc, referenced by the alias) ----
export function captureSession(aliasName: string, storageState: unknown, root = storeRoot()): string {
  const rel = join('sessions', `${aliasName}.storageState.enc`);
  writeFileSync(join(sessionsDir(root), `${aliasName}.storageState.enc`), encryptJSON(root, storageState));
  updateAlias(aliasName, { session: rel }, root);
  return rel;
}
export async function captureFromInstance(inst: Instance, root = storeRoot()): Promise<string> {
  const state = await inst.context.storageState();
  return captureSession(inst.alias, state, root);
}

// ---- EXPORT / IMPORT (portable bundle = source + alias [+ plaintext storageState]) ----
export interface Bundle {
  kind: 'cen55-bundle';
  alias: string;
  source: Source;
  aliasDef: Alias;
  storageState?: unknown; // PLAINTEXT — only when explicitly requested; secret, handle with care
}
export function exportAlias(aliasName: string, withSession = false, root = storeRoot()): Bundle {
  const aliasDef = readAlias(aliasName, root);
  const source = readSource(aliasDef.src, root);
  const b: Bundle = { kind: 'cen55-bundle', alias: aliasName, source, aliasDef: { ...aliasDef, session: null } };
  if (withSession && aliasDef.session) {
    b.storageState = decryptJSON(root, readFileSync(join(root, aliasDef.session)));
  }
  return b;
}
export function importBundle(b: Bundle, root = storeRoot()): void {
  if (b.kind !== 'cen55-bundle') throw new Error('not a cen55-bundle');
  if (!listSources(root).includes(b.alias) && !existsSync(join(root, 'sources', `${b.source.engine}-${b.alias}.json`))) {
    // write source under the alias def's src name
  }
  if (!listSources(root).includes(b.aliasDef.src)) writeSource(b.aliasDef.src, b.source, root);
  writeAlias(b.alias, { ...b.aliasDef, session: null }, root);
  if (b.storageState) captureSession(b.alias, b.storageState, root); // re-encrypt with THIS machine's key
}

// CEN-55 canonical profile store — schema types.
// Two layers: canonical schema (portable, versioned) vs materialized profile (machine-bound).
// See backlog CEN-55 + docs. Nothing OS-specific belongs in Source/Alias — that lives in Machine.

export type Engine = 'chromium' | 'firefox';
export type OS = 'darwin' | 'win32' | 'linux'; // open enum: add an OS = additive, no schema change

export interface Policy {
  allow: string[]; // hostname globs permitted (empty = permit-all)
  block: string[]; // hostname globs denied (wins over allow)
}

// A Source is an OS-agnostic template. One src → N aliases.
export interface Source {
  engine: Engine;
  description?: string;
  policy: Policy;
  prefs: Record<string, unknown>; // prefs-intent (engine-neutral keys; realized per-engine by the builder)
  extensions: string[];           // by id (Chrome CRX id / Firefox addon id) — realized per-engine
  fingerprint: Record<string, unknown>; // v1 minimal
  flags: string[];                // launch flags
}

// An Alias is an instance: pick a src, a concrete target, optional overrides + a referenced session.
export interface Alias {
  id: string;                          // UUID — stable machine identity, generated at create; independent of the (renamable) alias name. Keys the materialized dir + CDP port.
  src: string;
  target: { os: OS; browser: string }; // browser = concrete binary within the engine family (chrome|chromium|firefox|msedge)
  overlay: Partial<Source>;            // per-alias overrides merged over the src
  session: string | null;             // path (relative to store root) to a sessions/<name>.storageState.enc — REFERENCED, not inlined
}

// Per-machine, gitignored. The ONLY place OS-specific binary paths live.
export interface Machine {
  os: OS;
  clonesRoot: string; // where materialized user-data-dirs are created (may contain $HOME)
  binaries: Partial<Record<OS, Record<string, string>>>; // os -> browser -> binary path
}

export interface Index {
  version: number;
  sources: string;
  aliases: string;
  sessions: string;
  machine: string;
}

// The fully-resolved config for one alias (src + overlay merged), ready for the builder.
export interface Resolved {
  id: string;    // stable UUID — keys the materialized dir + port
  alias: string;
  engine: Engine;
  browser: string;
  os: OS;
  policy: Policy;
  prefs: Record<string, unknown>;
  extensions: string[];
  fingerprint: Record<string, unknown>;
  flags: string[];
  sessionPath: string | null; // absolute path to the .enc, or null
}

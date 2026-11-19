// ─── Multi-agent tab/browser lease (Phase 1: in-process, SQLite-backed) ────────
// Problem: profile CDP ports are fixed + detached, so EVERY MCP process (every Claude
// session) and every sibling subagent connects to the SAME Chrome and can drive each
// other's tabs. This grants a per-tab lease: a MUTATE on a tab another live owner holds is
// denied (fail-closed); READS stay free (they don't collide).
//
// Identity: owner = `${pid}:${label}`. pid is the real OS pid — it cannot be spoofed across
// processes, so cross-session collisions are blocked by pid alone. `label` is a caller tag
// that distinguishes sibling subagents INSIDE one process (they share a pid). A per-OWNER
// capability TOKEN (minted once per owner per process; only its sha256 is stored, and the SAME
// token covers every tab that owner holds) closes the one spoofable gap — a sibling passing
// another sibling's label — because (re)authorizing a held tab requires the token, not just the
// matching label. Per-owner (not per-lease) so the tool's single `token` param can re-authorize
// ALL of an owner's held tabs across calls with one value.
//
// Ground truth: a lease is reclaimable the moment its owner PROCESS is dead (checked here via
// process.kill(pid,0)) or its TAB is gone (checked by the caller via CDP /json, since only the
// caller knows the port) — NOT merely because a TTL elapsed. TTL is kept for observability and
// the future reaper, not as the reclaim gate.
//
// Backend is swappable behind LeaseClient: Phase 1 = SqliteLeaseStore (this file; in-proc,
// cross-process-safe via SQLite WAL + BEGIN IMMEDIATE). Phase 2 = a DaemonLeaseClient (lazy
// singleton daemon, same interface) — the chokepoint in index.ts will not change.

import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

export interface Lease {
    targetId: string;
    profile: string;
    owner: string;   // "<pid>:<label>"
    pid: number;
    createdMs: number;
    heartbeatMs: number;
    live: boolean;   // owner process still alive
}

export interface AcquireResult {
    ok: boolean;
    token?: string;      // present iff ok — this owner's capability token (SAME for all its leases)
    owner: string;       // ours on ok; the blocking owner on !ok
    reason?: string;     // present iff !ok
    heldSinceMs?: number;
}

// Phase-1 and Phase-2 backends both satisfy this. The chokepoint only knows this surface.
export interface LeaseClient {
    ownerFor(label: string): string;
    // first-acquire-wins on targetId. Grants if free / owner-dead / (same owner WITH its token).
    // Denies if a different live owner holds it, or the same-labelled owner is live but no valid
    // token is presented (spoof guard).
    acquire(targetId: string, profile: string, label: string, token?: string): AcquireResult;
    // renew TTL for a tab the caller provably holds (owner + token). false if not the holder.
    heartbeat(targetId: string, label: string, token?: string): boolean;
    // drop a lease the caller provably holds (owner + token). false if not the holder.
    release(targetId: string, label: string, token?: string): boolean;
    // server-internal reclaim used only after the CDP ground-truth says the tab is gone. No token.
    adminRelease(targetId: string): void;
    list(): Lease[];
}

const TTL_MS = Number(process.env.INSPECTOR_LEASE_TTL_MS) || 600_000; // 10 min (observability/reaper hint)

function sha256(s: string): string { return createHash('sha256').update(s).digest('hex'); }

// true = process exists (EPERM = exists but not ours); false = gone (ESRCH). Local-host only, which
// holds here: every MCP client and every browser run on the same machine as this store.
function pidAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; }
    catch (e: any) { return e?.code === 'EPERM'; }
}

// Synchronous sleep (DatabaseSync has no async path): block this thread for ms without busy-spinning.
function sleepSync(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// The single machine-global home for ALL browser-inspector runtime/shared state — the lease DB now,
// the Phase-2 daemon's socket/pidfile/reaper later — so they all derive from ONE base instead of
// re-hardcoding `~/.browser-inspector`. Machine-global on purpose: the collision domain is the whole
// machine (every MCP process reaches the same fixed CDP ports regardless of launch cwd), so the shared
// ledger must sit where every local process resolves it identically — NOT under the project dir, whose
// $PWD differs across worktrees / nested clones. INSPECTOR_STATE_DIR relocates the whole home in one
// var; the default keeps the historical path. (browser-profiles.json is the OTHER home — project-
// relative + git-tracked — and deliberately does not live here.)
export function stateDir(): string {
    return process.env.INSPECTOR_STATE_DIR || join(homedir(), '.browser-inspector');
}

export class SqliteLeaseStore implements LeaseClient {
    private db: DatabaseSync;
    // owner -> the one capability token minted for it in THIS process. In-memory is correct: a lease
    // can only ever be re-authorized by the same process that minted it (the `mine` check requires
    // r.owner === owner, and owner embeds this process's pid), so no other process needs this value.
    private sessionTokens = new Map<string, string>();

    constructor(dbPath = process.env.INSPECTOR_LEASE_DB || join(stateDir(), 'leases.db')) {
        mkdirSync(dirname(dbPath), { recursive: true });
        this.db = new DatabaseSync(dbPath);
        this.db.exec('PRAGMA busy_timeout=5000'); // FIRST: makes ordinary lock waits (CREATE TABLE, BEGIN IMMEDIATE) block instead of erroring
        this.initWal();
        this.db.exec(`CREATE TABLE IF NOT EXISTS leases (
            target_id    TEXT PRIMARY KEY,
            profile      TEXT NOT NULL,
            owner        TEXT NOT NULL,
            pid          INTEGER NOT NULL,
            token_hash   TEXT NOT NULL,
            created_ms   INTEGER NOT NULL,
            heartbeat_ms INTEGER NOT NULL
        )`);
    }

    // Switching a fresh DB into WAL needs a lock SQLite grants only when NO other connection has the
    // file open, so under a cold-start herd of processes it returns SQLITE_BUSY *immediately* —
    // busy_timeout does NOT cover the mode switch. Retry until one process wins the switch (after
    // which everyone else sees WAL as a no-op). Best-effort: first-acquire-wins rests on
    // BEGIN IMMEDIATE + busy_timeout, not on WAL, so fall through rather than crash if it never wins.
    private initWal(): void {
        for (let i = 0; i < 25; i++) {
            try { this.db.exec('PRAGMA journal_mode=WAL'); return; }
            catch (e: any) {
                if (!/lock|busy/i.test(String(e?.message))) throw e;
                sleepSync(20 + Math.floor(Math.random() * 60));
            }
        }
    }

    ownerFor(label: string): string { return `${process.pid}:${label ?? ''}`; }

    // One capability token per owner per process, minted lazily and reused for every tab that owner
    // holds — so a single `token` param re-authorizes all of them on the next call.
    private sessionToken(owner: string): string {
        let t = this.sessionTokens.get(owner);
        if (!t) { t = randomBytes(16).toString('hex'); this.sessionTokens.set(owner, t); }
        return t;
    }

    private row(targetId: string): any {
        return this.db.prepare('SELECT * FROM leases WHERE target_id=?').get(targetId);
    }

    acquire(targetId: string, profile: string, label: string, token?: string): AcquireResult {
        const owner = this.ownerFor(label);
        const now = Date.now();
        this.db.exec('BEGIN IMMEDIATE'); // write-intent lock: makes first-acquire-wins atomic across processes
        try {
            const r = this.row(targetId);
            if (r && pidAlive(r.pid)) {
                const mine = r.owner === owner && !!token && sha256(token) === r.token_hash;
                if (!mine) {
                    // live holder that we cannot prove is us → fail-closed deny.
                    // (The caller still does the tab-existence ground-truth and may adminRelease+retry.)
                    this.db.exec('COMMIT');
                    const reason = r.owner === owner
                        ? 'held under your label but no valid token presented'
                        : 'held by another live owner';
                    return { ok: false, owner: r.owner, reason, heldSinceMs: r.created_ms };
                }
                // proven current holder re-acquiring → echo the SAME token, just refresh heartbeat
                this.db.prepare('UPDATE leases SET heartbeat_ms=? WHERE target_id=?').run(now, targetId);
                this.db.exec('COMMIT');
                return { ok: true, token, owner };
            }
            // free, or previous owner's process is dead → grant. Reuse this owner's per-process session
            // token so ONE token re-authorizes EVERY tab the owner holds (a single `token` param can't
            // carry a distinct per-tab token for 2+ tabs held across calls). Still a random secret —
            // only its sha256 is stored — so the sibling-label spoof guard is unchanged.
            const tok = this.sessionToken(owner);
            this.db.prepare(`INSERT INTO leases
                (target_id, profile, owner, pid, token_hash, created_ms, heartbeat_ms)
                VALUES (?,?,?,?,?,?,?)
                ON CONFLICT(target_id) DO UPDATE SET
                    profile=excluded.profile, owner=excluded.owner, pid=excluded.pid,
                    token_hash=excluded.token_hash, created_ms=excluded.created_ms, heartbeat_ms=excluded.heartbeat_ms`
            ).run(targetId, profile, owner, process.pid, sha256(tok), now, now);
            this.db.exec('COMMIT');
            return { ok: true, token: tok, owner };
        } catch (e) {
            try { this.db.exec('ROLLBACK'); } catch { /* ignore */ }
            throw e;
        }
    }

    heartbeat(targetId: string, label: string, token?: string): boolean {
        const r = this.row(targetId);
        if (!r || r.owner !== this.ownerFor(label) || !token || sha256(token) !== r.token_hash) return false;
        this.db.prepare('UPDATE leases SET heartbeat_ms=? WHERE target_id=?').run(Date.now(), targetId);
        return true;
    }

    release(targetId: string, label: string, token?: string): boolean {
        const r = this.row(targetId);
        if (!r || r.owner !== this.ownerFor(label) || !token || sha256(token) !== r.token_hash) return false;
        this.db.prepare('DELETE FROM leases WHERE target_id=?').run(targetId);
        return true;
    }

    adminRelease(targetId: string): void {
        this.db.prepare('DELETE FROM leases WHERE target_id=?').run(targetId);
    }

    list(): Lease[] {
        return (this.db.prepare('SELECT * FROM leases ORDER BY created_ms').all() as any[]).map(r => ({
            targetId: r.target_id, profile: r.profile, owner: r.owner, pid: r.pid,
            createdMs: r.created_ms, heartbeatMs: r.heartbeat_ms, live: pidAlive(r.pid),
        }));
    }
}

export { TTL_MS };

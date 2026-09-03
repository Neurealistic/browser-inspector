#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Browser, Page } from 'playwright';
import { createRequire } from 'node:module';

// ESM build: a CJS-style require for loading the compiled profile store lazily and the standalone
// `playwright` fallback (both resolve fine via Node's require(ESM) on Node >= 22.12).
const require = createRequire(import.meta.url);

// ─── CDP connection ──────────────────────────────────────────────────────────

import { execSync } from 'child_process';
import { readFileSync, mkdirSync, readdirSync, statSync, unlinkSync, renameSync, writeFileSync, rmSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { pathToFileURL } from 'node:url';

// ─── Capture storage ─────────────────────────────────────────────────────────

const captureConfig = {
    dir: join(process.env.INSPECTOR_HOME ?? process.cwd(), 'tmp', 'captures'),
    limitBytes: 1 * 1024 * 1024 * 1024, // 1 GB
};

function ensureCaptureDir(): void {
    mkdirSync(captureConfig.dir, { recursive: true });
}

function getCaptureFiles(): { path: string; size: number; mtime: number }[] {
    try {
        return readdirSync(captureConfig.dir)
            .filter(f => f.endsWith('.png') || f.endsWith('.webm') || f.endsWith('.zip'))
            .map(f => {
                const p = join(captureConfig.dir, f);
                const s = statSync(p);
                return { path: p, size: s.size, mtime: s.mtimeMs };
            })
            .sort((a, b) => a.mtime - b.mtime); // oldest first (FIFO)
    } catch { return []; }
}

function cleanCaptures(): string {
    const files = getCaptureFiles();
    const total = files.reduce((s, f) => s + f.size, 0);
    if (total <= captureConfig.limitBytes) return `No cleanup needed (${(total / 1e6).toFixed(1)} MB used)`;
    let freed = 0;
    let removed = 0;
    let remaining = total;
    for (const f of files) {
        if (remaining <= captureConfig.limitBytes) break;
        try { unlinkSync(f.path); freed += f.size; remaining -= f.size; removed++; } catch {}
    }
    return `Removed ${removed} file(s), freed ${(freed / 1e6).toFixed(1)} MB — now ${(remaining / 1e6).toFixed(1)} MB`;
}

// Auto-clean every hour
setInterval(() => { try { cleanCaptures(); } catch {} }, 60 * 60 * 1000);
ensureCaptureDir();

// Load a .env from INSPECTOR_HOME (or cwd) so api_user.* can mint tokens without exported vars.
// Runtime process read; only fills vars not already set in the environment.
(function loadEnv() {
    try {
        const envPath = join(process.env.INSPECTOR_HOME ?? process.cwd(), '.env');
        for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
            const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
            if (m && process.env[m[1]] === undefined) {
                let v = m[2];
                if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
                process.env[m[1]] = v;
            }
        }
    } catch { /* no .env — api_user.as errors only if creds are actually missing */ }
})();

// Static profile map (binary + user-data-dir + fixed CDP port per named profile). Read from
// INSPECTOR_PROFILES (or <INSPECTOR_HOME>/browser-profiles.json). Optional: with PROFILE_STORE=1 the
// canonical store (canonical/) supplies profiles instead, so a missing file is not an error.
const PROFILES_PATH = process.env.INSPECTOR_PROFILES
    ?? join(process.env.INSPECTOR_HOME ?? process.cwd(), 'browser-profiles.json');
const BROWSER_PROFILES: Record<string, { binary: string; profile: string; cdpPort: number; use?: string; allowedPatterns?: string[]; blockedPatterns?: string[] }> =
    existsSync(PROFILES_PATH) ? JSON.parse(readFileSync(PROFILES_PATH, 'utf-8')) : {};

// Replace $HOME in paths
function resolvePath(p: string): string {
    return p.replace(/\$HOME/g, process.env.HOME ?? '');
}

const browsers: Record<string, import('playwright').Browser | null> = {};

// ─── CEN-55 canonical profile store (opt-in via PROFILE_STORE=1) ──────────────
// When on, profile resolution comes from canonical/ (sources+aliases) instead of browser-profiles.json,
// and a fresh launch injects the alias's storageState session over CDP. Off = legacy behaviour, untouched.
const PROFILE_STORE = process.env.PROFILE_STORE === '1';
const pendingInject = new Set<string>();
let _profileBuilder: any;
function profileBuilder(): any { return _profileBuilder ??= require('./profile/builder.js'); }
async function maybeInject(profileName: string, cdpUrl: string): Promise<void> {
    if (!PROFILE_STORE || !pendingInject.has(profileName)) return;
    pendingInject.delete(profileName);
    try { await profileBuilder().injectDetached(cdpUrl, profileName); }
    catch (e) { console.error(`injectDetached(${profileName}) warn: ${(e as Error).message}`); }
}

// ─── Agency multi-agent isolation (CEN-2) ────────────────────────────────────
// When AGENT_KEY (a per-agent id) is set, each agent drives its OWN Chrome instance — a CLONE of the
// base profile (same account cookies) in its own user-data-dir on its own dynamic CDP port — so N
// agents run concurrently on the same account without tab/session contention and without hitting
// Chromium's SingletonLock (a distinct user-data-dir side-steps it).
// Absent AGENT_KEY → shared fixed-port behaviour (single-user sessions are unchanged).
const AGENT_KEY = process.env.AGENT_KEY || '';
const AGENCY = !!AGENT_KEY;
const AKEY = AGENT_KEY.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
const CLONE_BASE_PORT = 9300;

function hashKey(s: string): number { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
function portListening(p: number): boolean { try { execSync(`lsof -nP -iTCP:${p} -sTCP:LISTEN`, { stdio: 'pipe' }); return true; } catch { return false; } }
function cdpAlive(p: number): boolean { try { execSync(`curl -s --max-time 1 http://localhost:${p}/json/version`, { stdio: 'pipe' }); return true; } catch { return false; } }

// Clone a base profile into a per-agent dir (once). rsync -a minus locks + caches keeps cookies /
// localStorage / IndexedDB (the auth surfaces) while skipping the heavy, disposable cache dirs.
function cloneProfile(src: string, dest: string): void {
    if (existsSync(join(dest, 'Local State')) || existsSync(join(dest, 'Default'))) return; // already cloned
    if (!existsSync(src)) { mkdirSync(dest, { recursive: true }); return; } // no base yet → fresh profile
    mkdirSync(dest, { recursive: true });
    const excludes = ['Singleton*', 'Default/Cache', 'Default/Code Cache', 'Default/GPUCache',
        'Default/Service Worker/CacheStorage', 'GPUCache', 'ShaderCache', 'component_crx_cache'];
    try {
        execFileSync('rsync', ['-a', ...excludes.flatMap(e => ['--exclude', e]), src + '/', dest + '/'], { stdio: 'ignore' });
    } catch {
        execSync(`cp -R '${src}/.' '${dest}/'`, { stdio: 'ignore' });
    }
    for (const s of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) { try { rmSync(join(dest, s), { force: true }); } catch {} }
}

// Map a base profile name to the effective key this process should use. Idempotent (an already-effective
// key passes through). Under agency it lazily materializes a synthesized BROWSER_PROFILES entry pointing
// at the agent's clone dir + a persisted free CDP port, so every existing code path works unchanged.
function effectiveProfile(profileName = 'admin'): string {
    if (PROFILE_STORE) {
        // Canonical store path: synthesize the BROWSER_PROFILES entry from the alias (binary + uuid dir +
        // dynamic port). All downstream code (spawn/connect/status/close) then works unchanged.
        try {
            const e = profileBuilder().resolveAliasEntry(profileName);
            BROWSER_PROFILES[profileName] = { ...(BROWSER_PROFILES[profileName] || {}), binary: e.binary, profile: e.profile, cdpPort: e.cdpPort };
            return profileName;
        } catch (err) { /* alias not in store → fall through to legacy resolution */ }
    }
    if (!AGENCY) return profileName;
    if (profileName.endsWith('__' + AKEY)) return profileName;
    const base = BROWSER_PROFILES[profileName];
    if (!base) return profileName; // let downstream throw the clear "unknown profile" error
    const key = `${profileName}__${AKEY}`;
    if (BROWSER_PROFILES[key]) return key;
    const cloneDir = resolvePath(base.profile) + '__' + AKEY;
    cloneProfile(resolvePath(base.profile), cloneDir);
    const portFile = join(cloneDir, '.cdp-port');
    let port = 0;
    if (existsSync(portFile)) { const v = parseInt(readFileSync(portFile, 'utf-8').trim(), 10); if (v) port = v; }
    if (!port || (portListening(port) && !cdpAlive(port))) { // no port yet, or ours died and the slot was reused
        let p = CLONE_BASE_PORT + (hashKey(AKEY + profileName) % 600);
        while (portListening(p)) p++;
        port = p;
        try { writeFileSync(portFile, String(port)); } catch {}
    }
    BROWSER_PROFILES[key] = { ...base, profile: cloneDir, cdpPort: port };
    return key;
}

function ensureBrowserRunning(profileName = 'admin'): void {
    profileName = effectiveProfile(profileName);
    const profile = BROWSER_PROFILES[profileName];
    if (!profile) throw new Error(`Unknown browser profile "${profileName}" — available: ${Object.keys(BROWSER_PROFILES).join(', ')}`);
    const cdpUrl = `http://localhost:${profile.cdpPort}`;
    const binary = resolvePath(profile.binary);
    const userDataDir = resolvePath(profile.profile);
    try {
        execSync(`curl -s --max-time 1 ${cdpUrl}/json/version`, { stdio: 'pipe' });
    } catch {
        execSync(
            `'${binary}' --user-data-dir='${userDataDir}' --remote-debugging-port=${profile.cdpPort} --no-first-run --no-default-browser-check &`,
            { stdio: 'ignore' }
        );
        let ready = false;
        for (let i = 0; i < 10; i++) {
            try {
                execSync(`curl -s --max-time 1 ${cdpUrl}/json/version`, { stdio: 'pipe' });
                ready = true;
                break;
            } catch {
                execSync('sleep 0.5', { stdio: 'ignore' });
            }
        }
        if (!ready) throw new Error(`${profileName} browser CDP not ready after 5s`);
        if (PROFILE_STORE) pendingInject.add(profileName); // fresh launch → inject session on next connect
    }
}

function matchesPattern(url: string, pattern: string): boolean {
    try {
        const host = new URL(url).hostname;
        if (pattern === host) return true;
        // *.domain.com matches any subdomain at any depth
        if (pattern.startsWith('*.')) {
            const suffix = pattern.slice(1); // .domain.com
            return host.endsWith(suffix) || host === suffix.slice(1);
        }
        return false;
    } catch { return false; }
}

function checkUrlAllowed(url: string, profileName: string): void {
    const profile = BROWSER_PROFILES[profileName];
    if (!profile || (!profile.allowedPatterns?.length && !profile.blockedPatterns?.length)) return;
    const blocked = profile.blockedPatterns?.some(p => matchesPattern(url, p));
    if (blocked) throw new Error(`URL "${url}" is blocked for profile "${profileName}" — use the correct browser`);
    const allowed = profile.allowedPatterns?.some(p => matchesPattern(url, p));
    if (profile.allowedPatterns?.length && !allowed) {
        throw new Error(`URL "${url}" is not in the allowed list for profile "${profileName}" — use the correct browser`);
    }
}

// Root for dynamic-import ("module/path:Class.method") resolution: a project whose page objects /
// services you want to drive. Defaults to INSPECTOR_HOME (or cwd). Set POM_REPO_DIR to point at an
// external repo (its tsconfig `paths` + its @playwright/test are used, so Page/Locator are
// instanceof-compatible with that repo's expect() matchers).
const POM_REPO_DIR = process.env.POM_REPO_DIR ?? process.env.INSPECTOR_HOME ?? process.cwd();

// Module resolution for dynamic-import steps: mirror the target repo's tsconfig `paths` (longest
// prefix wins) so a specifier like "src/pages/…" or "pages/…" maps to its file. Feeds importFresh's
// mtime cache-busting.
const TSCONFIG_PATH_PREFIXES: Array<[string, string]> = (() => {
    try {
        const paths = JSON.parse(readFileSync(join(POM_REPO_DIR, 'tsconfig.json'), 'utf8')).compilerOptions?.paths ?? {};
        return Object.entries(paths)
            .map(([alias, targets]): [string, string] =>
                [alias.replace(/\*$/, ''), join(POM_REPO_DIR, (targets as string[])[0].replace(/\*$/, ''))])
            .sort((a, b) => b[0].length - a[0].length);
    } catch { return []; }
})();

function resolveModuleFile(spec: string): string | null {
    const bases = TSCONFIG_PATH_PREFIXES
        .filter(([prefix]) => spec.startsWith(prefix))
        .map(([prefix, target]) => join(target, spec.slice(prefix.length)));
    bases.push(join(POM_REPO_DIR, spec));
    for (const base of bases) {
        for (const suffix of ['.ts', '.tsx', '.js', '', '/index.ts']) {
            const file = base + suffix;
            if (existsSync(file) && statSync(file).isFile()) return file;
        }
    }
    return null;
}

async function importFresh(spec: string): Promise<any> {
    const file = resolveModuleFile(spec);
    if (!file) return import(spec);
    return import(`${pathToFileURL(file).href}?v=${statSync(file).mtimeMs}`);
}

// Resolve the Playwright BrowserType used to connectOverCDP / launch. When POM_REPO_DIR has its own
// @playwright/test, use THAT instance so Page/Locator are instanceof-compatible with the repo's
// expect(...) matchers, and shim test.info()/test.step() so POM methods run outside the test runner
// (e.g. default args reading test.info().workerIndex, or bodies wrapped in test.step). When no such
// repo is present, fall back to this package's own `playwright` (no `test` export → shims skipped).
let _chromium: any;
function repoPlaywright(): any {
    if (_chromium) return _chromium;
    let pw: any;
    try {
        const req = createRequire(join(POM_REPO_DIR, 'package.json'));
        pw = req('@playwright/test');
    } catch {
        pw = require('playwright'); // standalone: no external POM repo
    }
    _chromium = pw.chromium;
    if (pw.test && typeof pw.test.info === 'function') {
        const realInfo = pw.test.info.bind(pw.test);
        pw.test.info = () => {
            try { return realInfo(); }
            catch { return { workerIndex: 0, parallelIndex: 0, retry: 0, project: { name: 'inspector' }, attach: async () => {}, attachments: [], annotations: [] }; }
        };
    }
    if (pw.test && typeof pw.test.step === 'function') {
        pw.test.step = async (_name: string, fn: () => any) => await fn();
    }
    return _chromium;
}

// Resolve a page in a profile. `selector`:
//   undefined → the first tab (default, back-compat)
//   number    → 0-based index across the profile (flat over all windows; matches capturedPage)
//   string    → first tab whose URL contains the substring
// CDP drives any target/tab via its own session — the tab does NOT need to be foregrounded.
async function getPage(profileName = 'admin', selector?: number | string): Promise<Page> {
    profileName = effectiveProfile(profileName);
    const profile = BROWSER_PROFILES[profileName];
    if (!profile) throw new Error(`Unknown browser profile "${profileName}"`);
    const cdpUrl = `http://localhost:${profile.cdpPort}`;
    ensureBrowserRunning(profileName);
    if (!browsers[profileName] || !browsers[profileName]!.isConnected()) {
        browsers[profileName] = await repoPlaywright().connectOverCDP(cdpUrl);
    }
    const b = browsers[profileName]!;
    const contexts = b.contexts();
    if (!contexts.length) throw new Error(`No browser context — open a tab in ${profileName} browser`);
    const pages = contexts.flatMap(c => c.pages());
    if (!pages.length) throw new Error(`No open page in ${profileName} browser`);
    let page: Page | undefined;
    if (selector === undefined) page = pages[0];
    else if (typeof selector === 'number') page = pages[selector];
    else page = pages.find(pg => pg.url().includes(selector));
    if (!page) throw new Error(
        `No tab matching ${JSON.stringify(selector)} in "${profileName}" — open tabs: ` +
        pages.map((pg, i) => `[${i}] ${pg.url()}`).join(', ')
    );
    (page as any)._profileName = profileName;
    return page;
}

// ─── Registry ────────────────────────────────────────────────────────────────
// page.* / pw.* primitive steps. steps[ns][methodName] = async (page, param) => result

type StepFn = (page: Page, param?: any) => Promise<string | undefined>;

const steps: Record<string, Record<string, StepFn>> = {

    page: {
        navigate: async (p, url) => {
            // Validate URL against profile whitelist/blacklist
            const profileName = (p as any)._profileName ?? 'admin';
            checkUrlAllowed(url, profileName);
            await p.goto(url, { waitUntil: 'load' });
            return `Navigated to ${url}`;
        },

        // Start capturing all network responses + WebSocket frames (non-blocking)
        // param: { filter?: string } - optional URL filter
        startCapture: async (p, param) => {
            const filter: string = param?.filter ?? '';
            (p as any)._captureLog = [];
            const log = (p as any)._captureLog;
            p.on('response', r => {
                if (!filter || r.url().includes(filter)) {
                    log.push({ type: 'http', method: r.request().method(), status: r.status(), url: r.url() });
                }
            });
            p.on('websocket', ws => {
                if (!filter || ws.url().includes(filter)) {
                    log.push({ type: 'ws:open', url: ws.url() });
                    ws.on('framesent', f => log.push({ type: 'ws:sent', url: ws.url(), data: f.payload?.toString()?.substring(0, 300) }));
                    ws.on('framereceived', f => log.push({ type: 'ws:recv', url: ws.url(), data: f.payload?.toString()?.substring(0, 300) }));
                }
            });
            return `Capture started (filter="${filter}")`;
        },

        // Get captured network events since startCapture
        getCapture: async (p) => {
            const log = (p as any)._captureLog ?? [];
            return JSON.stringify(log, null, 2);
        },

        // Clear capture log
        clearCapture: async (p) => {
            (p as any)._captureLog = [];
            return 'Capture cleared';
        },
        reload: async (p, opts) => {
            await p.reload({ waitUntil: opts?.waitUntil ?? 'load' });
            return 'Page reloaded';
        },
        screenshot: async (p, path) => {
            const dest = path ?? `tmp/debug-${Date.now()}.png`;
            await p.screenshot({ path: dest });
            return `Screenshot: ${dest}`;
        },
        clearSession: async (p) => {
            await p.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
            await p.context().clearCookies();
            await p.reload({ waitUntil: 'load' });
            return 'Session cleared (localStorage, sessionStorage, cookies)';
        },
        evaluate: async (p, fn) => {
            const result = await p.evaluate(new Function(`return (${fn})()`) as any);
            return typeof result === 'string' ? result : JSON.stringify(result);
        },
        url: async (p) => p.url(),
        title: async (p) => await p.title(),

        // Start capturing network responses matching a URL filter
        // param: { filter: string, timeout?: number } - waits for next matching response
        waitForNetworkResponse: async (p, param) => {
            const filter: string = param?.filter ?? '';
            const timeout: number = param?.timeout ?? 10000;
            const response = await p.waitForResponse(
                r => r.url().includes(filter),
                { timeout }
            );
            return JSON.stringify({
                url: response.url(),
                method: response.request().method(),
                status: response.status(),
                resourceType: response.request().resourceType(),
            });
        },

        // Listen for WebSocket messages matching a URL filter
        // param: { filter: string, timeout?: number }
        waitForWebSocket: async (p, param) => {
            const filter: string = param?.filter ?? '';
            const timeout: number = param?.timeout ?? 10000;
            return new Promise<string>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error(`No WebSocket matching "${filter}" within ${timeout}ms`)), timeout);
                p.on('websocket', ws => {
                    if (!ws.url().includes(filter)) return;
                    clearTimeout(timer);
                    const frames: any[] = [];
                    ws.on('framesent', f => frames.push({ dir: 'sent', data: f.payload?.toString()?.substring(0, 200) }));
                    ws.on('framereceived', f => frames.push({ dir: 'recv', data: f.payload?.toString()?.substring(0, 200) }));
                    setTimeout(() => resolve(JSON.stringify({ url: ws.url(), frames })), 5000);
                });
            });
        },
    },

    // Raw Playwright actions
    pw: {
        click: async (p, selector: string) => {
            await p.locator(selector).click();
            return `Clicked: ${selector}`;
        },
        fill: async (p, { selector, value }: { selector: string; value: string }) => {
            await p.locator(selector).fill(value);
            return `Filled ${selector} = ${value}`;
        },
        type: async (p, { selector, text }: { selector: string; text: string }) => {
            await p.locator(selector).pressSequentially(text);
            return `Typed into ${selector}`;
        },
        press: async (p, { selector, key }: { selector: string; key: string }) => {
            await p.locator(selector).press(key);
            return `Pressed ${key} on ${selector}`;
        },
        waitFor: async (p, { selector, state }: { selector: string; state?: string }) => {
            await p.locator(selector).waitFor({ state: (state as any) ?? 'visible', timeout: 15000 });
            return `${selector} is ${state ?? 'visible'}`;
        },
        getText: async (p, selector: string) => {
            return await p.locator(selector).textContent() ?? '';
        },
        getAttribute: async (p, { selector, attr }: { selector: string; attr: string }) => {
            return await p.locator(selector).getAttribute(attr) ?? '';
        },
        evaluate: async (p, expression: string) => {
            const result = await p.evaluate(expression);
            return JSON.stringify(result);
        },
        selectOption: async (p, { selector, value }: { selector: string; value: string }) => {
            await p.locator(selector).selectOption(value);
            return `Selected ${value} in ${selector}`;
        },
        isVisible: async (p, selector: string) => {
            const visible = await p.locator(selector).isVisible();
            return String(visible);
        },
        count: async (p, selector: string) => {
            const n = await p.locator(selector).count();
            return String(n);
        },
    },

};

// ─── Browser management (no page needed) ─────────────────────────────────────

type BrowserFn = (param?: any) => Promise<string>;

const browserRegistry: Record<string, BrowserFn> = {
    // Full status: all profiles, contexts, pages with current URLs
    status: async () => {
        const lines: string[] = [];
        for (const [name, profile] of Object.entries(BROWSER_PROFILES)) {
            const cdpUrl = `http://localhost:${profile.cdpPort}`;
            try {
                execSync(`curl -s --max-time 1 ${cdpUrl}/json/version`, { stdio: 'pipe' });
                let b = browsers[name];
                if (!b || !b.isConnected()) {
                    b = await repoPlaywright().connectOverCDP(cdpUrl);
                    browsers[name] = b;
                }
                const contexts = b.contexts();
                lines.push(`✓ ${name} (port ${profile.cdpPort}) — ${contexts.length} window(s)`);
                for (let wi = 0; wi < contexts.length; wi++) {
                    const pages = contexts[wi].pages();
                    lines.push(`   Window ${wi + 1}: ${pages.length} tab(s)`);
                    for (let ti = 0; ti < pages.length; ti++) {
                        const url = pages[ti].url();
                        const title = await pages[ti].title().catch(() => '');
                        lines.push(`     Tab ${ti + 1}: ${url}${title ? ` — "${title}"` : ''}`);
                    }
                }
            } catch {
                lines.push(`✗ ${name} (port ${profile.cdpPort}) — not running`);
            }
        }
        return lines.join('\n');
    },

    // Open a browser profile
    open: async (profileName = 'admin') => {
        const key = effectiveProfile(profileName);
        ensureBrowserRunning(key);
        return `${profileName} browser launched (port ${BROWSER_PROFILES[key]?.cdpPort})`;
    },

    // Close a browser profile
    close: async (profileName = 'admin') => {
        const key = effectiveProfile(profileName);
        const profile = BROWSER_PROFILES[key];
        if (!profile) throw new Error(`Unknown profile "${profileName}"`);
        try {
            const b = browsers[key];
            if (b && b.isConnected()) await b.close();
            browsers[key] = null;
        } catch {}
        // Kill by user-data-dir (unique per instance) — NOT by binary, which would kill every clone /
        // profile sharing that Chrome-for-Testing app (fatal under agency multi-instance).
        execSync(`pkill -f "user-data-dir=${resolvePath(profile.profile)}" 2>/dev/null || true`, { stdio: 'ignore' });
        return `${profileName} browser closed`;
    },

    // Capture management
    'capture.setDir': async (dir: string) => {
        captureConfig.dir = dir;
        ensureCaptureDir();
        return `Capture dir set to: ${dir}`;
    },
    'capture.setLimit': async (limitMb: number) => {
        captureConfig.limitBytes = limitMb * 1024 * 1024;
        return `Capture limit set to: ${limitMb} MB`;
    },
    'capture.clean': async () => cleanCaptures(),
    'capture.status': async () => {
        const files = getCaptureFiles();
        const total = files.reduce((s, f) => s + f.size, 0);
        return `Dir: ${captureConfig.dir} | ${files.length} file(s) | ${(total / 1e6).toFixed(1)} MB / ${(captureConfig.limitBytes / 1e6).toFixed(0)} MB limit`;
    },

    // List open pages in a profile
    pages: async (profileName = 'admin') => {
        const profile = BROWSER_PROFILES[profileName];
        if (!profile) throw new Error(`Unknown profile "${profileName}"`);
        const cdpUrl = `http://localhost:${profile.cdpPort}`;
        try {
            execSync(`curl -s --max-time 1 ${cdpUrl}/json/version`, { stdio: 'pipe' });
        } catch {
            return `${profileName} browser is not running`;
        }
        let b = browsers[profileName];
        if (!b || !b.isConnected()) {
            b = await repoPlaywright().connectOverCDP(cdpUrl);
            browsers[profileName] = b;
        }
        const contexts = b.contexts();
        if (!contexts.length) return `${profileName}: no open windows`;
        const lines: string[] = [];
        for (let wi = 0; wi < contexts.length; wi++) {
            const pages = contexts[wi].pages();
            lines.push(`Window ${wi + 1}: ${pages.length} tab(s)`);
            const urls = await Promise.all(pages.map(p => p.url()));
            urls.forEach((url, ti) => lines.push(`  Tab ${ti + 1}: ${url}`));
        }
        return lines.join('\n');
    },
};

// ─── Dispatch ────────────────────────────────────────────────────────────────

// ─── api_user: authed API calls (any account), independent of the UI ──────────────────────────
// Mint + cache bearer tokens against an OAuth login endpoint (API_OAUTH_LOGIN_URL), then call any
// {baseUrl, path}. Users table: many accounts live at once in one run, keyed by username; tokens are
// cached + reused until ~expiry. `request` picks a user via `as`, defaulting to the last-authed one.
// Per-user passwords come from <PW_PREFIX><USERNAME> env vars (PW_PREFIX defaults to API_PASSWORD_),
// or the default INSPECTOR_API_USER / INSPECTOR_API_PASSWORD pair.
const OAUTH_LOGIN_URL = process.env.API_OAUTH_LOGIN_URL ?? '';
const PW_PREFIX = process.env.INSPECTOR_PASSWORD_PREFIX ?? 'API_PASSWORD_';
const apiUsers = new Map<string, { token: string; expires: number }>();
let apiCurrentUser: string | null = null;

function apiPasswordFor(username: string, override?: string): string | undefined {
    const envKey = PW_PREFIX + username.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    return override ?? process.env[envKey] ?? (username === process.env.INSPECTOR_API_USER ? process.env.INSPECTOR_API_PASSWORD : undefined);
}

async function apiLogin(username: string, password: string): Promise<{ token: string; expires: number }> {
    if (!OAUTH_LOGIN_URL) throw new Error('api_user: set API_OAUTH_LOGIN_URL to the OAuth login endpoint');
    const res = await fetch(OAUTH_LOGIN_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
    });
    if (!res.ok) throw new Error(`api_user.as: login failed (${res.status}) for "${username}"`);
    const data: any = await res.json();
    const token = data.access_token ?? data.token;
    if (!token) throw new Error('api_user.as: login ok but no token in response');
    const expires = data.token_expires ? new Date(data.token_expires).getTime() : Date.now() + 3_600_000;
    return { token, expires };
}

// Resolve a username to a live token: reuse the cached one if it has >60s left, else (re-)login.
async function apiResolve(username: string, passwordOverride?: string): Promise<string> {
    const cached = apiUsers.get(username);
    if (cached && cached.expires > Date.now() + 60_000) return cached.token;
    const password = apiPasswordFor(username, passwordOverride);
    if (!password) {
        const envKey = PW_PREFIX + username.toUpperCase().replace(/[^A-Z0-9]/g, '_');
        throw new Error(`No password for "${username}" — set ${envKey} in .env, or pass {username, password}`);
    }
    const entry = await apiLogin(username, password);
    apiUsers.set(username, entry);
    return entry.token;
}

async function apiUserDispatch(method: string, param: any): Promise<any> {
    if (method === 'as') {
        const username: string = (typeof param === 'string' ? param : param?.username) ?? (process.env.INSPECTOR_API_USER as string);
        if (!username) throw new Error('api_user.as requires a username (string or {username, password}); or set INSPECTOR_API_USER in .env for the default');
        await apiResolve(username, param?.password);
        apiCurrentUser = username;
        return `api_user: authed as ${username} (${apiUsers.size} user(s) in table)`;
    }
    if (method === 'token') {
        // Store a raw token under a username (default "_manual") and make it current — for tokens minted elsewhere.
        const token: string = typeof param === 'string' ? param : param?.token;
        if (!token) throw new Error('api_user.token requires a token string (or {username, token})');
        const username: string = (typeof param === 'object' && param?.username) || '_manual';
        apiUsers.set(username, { token, expires: Date.now() + 3_600_000 });
        apiCurrentUser = username;
        return `api_user: token set for ${username}`;
    }
    if (method === 'users') {
        const now = Date.now();
        return Array.from(apiUsers.entries()).map(([u, e]) => ({
            username: u, current: u === apiCurrentUser, valid: e.expires > now,
        }));
    }
    if (method === 'request') {
        const { baseUrl, path, method: httpMethod = 'GET', pathParams, query, body, token, as } = param ?? {};
        if (!baseUrl || !path) throw new Error('api_user.request requires {baseUrl, path}');
        // Auth precedence: explicit token > the `as` user (auto-login if needed) > current user's cached token.
        let authToken: string | undefined = token;
        if (!authToken && as) authToken = await apiResolve(as);
        if (!authToken && apiCurrentUser) authToken = apiUsers.get(apiCurrentUser)?.token;
        if (!authToken) throw new Error('api_user.request: no auth — call api_user.as / api_user.token first, or pass {as} / {token}');
        let url = String(baseUrl).replace(/\/$/, '') + '/' + String(path).replace(/^\//, '');
        if (pathParams) for (const k of Object.keys(pathParams)) url = url.replace(new RegExp(`\\{${k}\\}`, 'g'), encodeURIComponent(String(pathParams[k])));
        if (query) { const qs = new URLSearchParams(query as any).toString(); if (qs) url += (url.includes('?') ? '&' : '?') + qs; }
        const res = await fetch(url, {
            method: httpMethod,
            headers: { Authorization: `Bearer ${authToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
            body: body ? JSON.stringify(body) : undefined,
        });
        const text = await res.text();
        let parsed: any; try { parsed = JSON.parse(text); } catch { parsed = text; }
        if (!res.ok) throw new Error(`api_user.request ${httpMethod} ${url} → ${res.status}: ${(typeof parsed === 'string' ? parsed : JSON.stringify(parsed)).slice(0, 200)}`);
        return parsed;
    }
    throw new Error(`Unknown api_user method "${method}" — use as, token, users, request`);
}

async function dispatch(page: Page, method: string, param?: any): Promise<any> {
    // browser.* — no page needed
    if (method.startsWith('browser.')) {
        const methodName = method.slice('browser.'.length);
        const fn = browserRegistry[methodName];
        if (!fn) throw new Error(`Unknown browser method "${methodName}" — available: ${Object.keys(browserRegistry).join(', ')}`);
        return fn(param);
    }

    // api_user.* — authed API calls, no page needed
    if (method.startsWith('api_user.')) {
        return apiUserDispatch(method.slice('api_user.'.length), param);
    }

    // Dynamic import: "module/path:ClassName.methodName"
    if (method.includes(':')) {
        // tsx's ESM loader caches modules for the process LIFETIME, so a POM edited
        // after its first import stayed stale ("Method not found") until the MCP server
        // restarted. importFresh keys the import URL by the resolved file's mtime:
        // unchanged files reuse the cache, edited files re-import. Only the TOP module
        // is busted — an edit deep in its dependency graph still needs a restart.
        const colonIdx = method.lastIndexOf(':');
        const modulePath = method.slice(0, colonIdx);
        const rest = method.slice(colonIdx + 1);
        const dot = rest.lastIndexOf('.');
        if (dot === -1) throw new Error(`Invalid dynamic method format — use "module/path:ClassName.methodName"`);
        const className = rest.slice(0, dot);
        const methodName = rest.slice(dot + 1);
        const mod = await importFresh(modulePath);
        const ClassDef = mod[className];
        if (!ClassDef) throw new Error(`Class "${className}" not found in module "${modulePath}"`);
        const args = Array.isArray(param) ? param : (param !== undefined ? [param] : []);
        let result: any;
        if (typeof ClassDef[methodName] === 'function') {
            // Static method (e.g. services) — call on the class directly, no instance/page needed.
            result = await ClassDef[methodName](...args);
        } else {
            const instance = new ClassDef(page);
            const fn = instance[methodName];
            if (typeof fn !== 'function') throw new Error(`Method "${methodName}" not found on "${className}" (neither static nor instance)`);
            result = await fn.call(instance, ...args);
        }
        return result;
    }

    // Primitive steps: "page.<m>" / "pw.<m>". Page objects & services use dynamic import (above).
    const dot = method.indexOf('.');
    if (dot === -1) throw new Error(`Invalid method "${method}" — use "page.<m>", "pw.<m>", or dynamic import "module/path:ClassName.methodName"`);
    const ns = method.slice(0, dot);
    const methodName = method.slice(dot + 1);
    const nsSteps = steps[ns];
    if (!nsSteps) throw new Error(`Unknown namespace "${ns}" — only "page" and "pw" are built in; for page objects/services use dynamic import "module/path:ClassName.methodName"`);
    const fn = nsSteps[methodName];
    if (fn) return fn(page, param);

    // Generic passthrough (pw.* only): call ANY Locator/Page method not in the
    // hand-written whitelist. Keeps the 11 typed helpers; opens the long tail.
    //   { selector, args? }  → page.locator(selector)[method](...args)
    //   { args? } (no sel)   → page[method](...args)
    //   any arg { selector } → resolved to a Locator (enables dragTo, etc.)
    if (ns === 'pw') {
        const resolveArg = (a: any) =>
            a && typeof a === 'object' && typeof a.selector === 'string' && Object.keys(a).length === 1
                ? page.locator(a.selector) : a;
        const raw = Array.isArray(param?.args) ? param.args
                  : param?.args !== undefined ? [param.args] : [];
        const args = raw.map(resolveArg);
        const target: any = param?.selector ? page.locator(param.selector) : page;
        if (typeof target[methodName] !== 'function')
            throw new Error(`pw.${methodName}: not a function on ${param?.selector ? 'Locator' : 'Page'}`);
        const result = await target[methodName](...args);
        if (result == null) return `pw.${methodName} ok`;
        const t = typeof result;
        return (t === 'string' || t === 'number' || t === 'boolean')
            ? String(result) : `pw.${methodName} ok (non-serializable)`;
    }
    throw new Error(`Unknown ${ns} method "${methodName}" — available: ${Object.keys(nsSteps).join(', ')}`);
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

const server = new Server(
    { name: 'browser-inspector', version: '1.0.0' },
    { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{
        name: 'run_steps',
        description: [
            'Execute a sequence of page object steps on a browser (via CDP).',
            'Batches multiple actions into one call to avoid round-trip overhead.',
            '',
            `Available browser profiles: ${Object.entries(BROWSER_PROFILES).map(([k, v]) => `${k} (port ${v.cdpPort} — ${v.use})`).join(', ')}`,
            '',
            'Browser management (no page needed):',
            `  browser: ${Object.keys(browserRegistry).join(', ')}`,
            '  — browser.status: check all profiles (running/stopped, page count)',
            '  — browser.open <profile>: launch a profile with CDP',
            '  — browser.close <profile>: close a profile',
            '  — browser.pages <profile>: list open pages in a profile',
            '',
            'Multi-tab (CDP drives ANY tab — it does NOT need to be foregrounded):',
            '  — page.select <index|URL-substring>: switch the ACTIVE tab for all subsequent steps (sticky)',
            '  — per-step "onPage": <index|URL-substring> runs just that one step on a specific tab',
            '  index is 0-based across the profile (same numbering as capturedPage); see browser.pages for the list',
            '  — screencast.switch <index|URL-substring>: under screencast, change WHICH page is recorded mid-flow',
            '    (page.select/onPage are ignored during screencast — screencast records page 0 by default; use this to follow a new tab). One continuous mp4.',
            '',
            'Primitive steps (require browser param):',
            ...Object.entries(steps).map(([ns, methods]) =>
                `  ${ns}: ${Object.keys(methods).join(', ')}`
            ),
            '',
            'Page objects & services — dynamic import (NOT a built-in namespace; needs POM_REPO_DIR):',
            '  "module/path:ClassName.methodName" e.g. pages/login.page:LoginPage.open',
            '  static methods (services) supported, e.g. api/services/order.service:OrderService.get',
            '',
            'api_user.* — authed API calls (any account), no page. Needs API_OAUTH_LOGIN_URL. Users table: many accounts cached at once, keyed by username:',
            '  api_user.as <username|{username,password}>  (logs in, caches token, becomes current)',
            '  api_user.token <token|{username,token}>      (store a raw token under a username)',
            '  api_user.users                                (list cached users + which is current/valid)',
            '  api_user.request {baseUrl, path, method?, pathParams?, query?, body?, as?, token?}  (as = route to a specific cached/loginable user)',
            '  e.g. {"method":"api_user.as","param":"<user>"} then {"method":"api_user.request","param":{"baseUrl":"https://api.example.com","path":"/items/{id}","pathParams":{"id":123}},"return":"item"} -> {{item.field}}',
            '  multi-user: api_user.as A; api_user.as B; then request with {"as":"A"} or {"as":"B"} to pick the actor per call',
        ].join('\n'),
        inputSchema: {
            type: 'object',
            properties: {
                browser: {
                    type: 'string',
                    description: 'Named browser profile to use (default "admin"); must be defined in browser-profiles.json or the canonical store.',
                },
                screenshot: {
                    type: 'boolean',
                    description: 'Take screenshot after every step (default: false). Per-step: add capturedPage to a step.',
                },
                recordVideo: {
                    type: 'boolean',
                    description: 'Record a VIDEO of the whole flow. Runs the steps in a fresh Playwright-launched context (recordVideo) instead of the persistent CDP browser — works for login-free flows. Saves a .webm to the capture dir; per-step screenshots are skipped. NOTE: a fresh context has no persisted session, so do not use for flows that need an already-logged-in profile.',
                },
                videoName: {
                    type: 'string',
                    description: 'Base filename (no extension) for the recorded video (recordVideo or screencast). Defaults to flow-<timestamp>.',
                },
                screencast: {
                    type: 'boolean',
                    description: 'Record a VIDEO of the flow on the ACTUAL inspector CDP browser (Chrome-for-Testing) via Page.startScreencast + ffmpeg. Unlike recordVideo (fresh launched context), this captures the real persistent browser you are driving. Saves <videoName>.mp4 to the capture dir; per-step screenshots skipped.',
                },
                fps: {
                    type: 'number',
                    description: 'Output frames-per-second for screencast video (default 8, floored at 4). Screencast frames are event-driven; ffmpeg resamples to this constant fps for smooth playback.',
                },
                steps: {
                    type: 'array',
                    description: 'Ordered steps to execute. Each step stops the sequence on error.',
                    items: {
                        type: 'object',
                        properties: {
                            method: {
                                type: 'string',
                                description: 'Primitive: "page.<m>" or "pw.<m>". Everything else (page objects, services) is dynamic import: "module/path:ClassName.methodName" e.g. "pages/login.page:LoginPage.open".',
                            },
                            param: {
                                description: 'Argument passed to the method (string, number, or object). Supports {{name}} / {{name.path}} interpolation from earlier steps that used "return" (a lone {{name}} keeps the raw value type).',
                            },
                            return: {
                                type: 'string',
                                description: 'Capture this step\'s result into a run-scoped variable; later steps reference it via {{name}} or {{name.path}} (e.g. {{otp.code}}). Enables one whole-flow run_steps call without splitting out dynamic values.',
                            },
                            capturedPage: {
                                description: 'Screenshot this page after step: page index (0-based) or URL substring. Defaults to active tab.',
                            },
                            onPage: {
                                description: 'Run THIS step on a specific tab: page index (0-based across the profile) or URL substring. CDP drives background tabs without foregrounding them. Omit = the active tab (default tab 0, or whatever page.select last set). For a sticky switch across many steps, use a page.select step instead.',
                            }
                        },
                        required: ['method']
                    }
                }
            },
            required: ['steps']
        }
    }]
}));

// Cross-step data: a step may capture its result with {return:"name"}; later params reference it
// via {{name}} or {{name.path}} (e.g. {{otp.code}}). A lone {{...}} preserves the raw value's type.
function getPath(obj: any, path: string): any {
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function interpolate(param: any, vars: Record<string, any>): any {
    if (typeof param === 'string') {
        const whole = param.match(/^\{\{\s*([^}]+?)\s*\}\}$/);
        if (whole) return getPath(vars, whole[1].trim());
        return param.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, p) => {
            const v = getPath(vars, String(p).trim());
            return v == null ? '' : String(v);
        });
    }
    if (Array.isArray(param)) return param.map((x) => interpolate(x, vars));
    if (param && typeof param === 'object') {
        const out: any = {};
        for (const k of Object.keys(param)) out[k] = interpolate(param[k], vars);
        return out;
    }
    return param;
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== 'run_steps') {
        return { content: [{ type: 'text', text: 'Unknown tool' }] };
    }

    const steps = request.params.arguments?.steps as Array<{ method: string; param?: any; capturedPage?: number | string; onPage?: number | string; return?: string }>;
    const profileName = (request.params.arguments?.browser as string) ?? 'admin';
    const screenshot = (request.params.arguments?.screenshot as boolean) ?? true;
    const recordVideo = (request.params.arguments?.recordVideo as boolean) ?? false;
    const screencast = (request.params.arguments?.screencast as boolean) ?? false;
    const fps = Math.max(4, (request.params.arguments?.fps as number) ?? 8);
    const videoName = (request.params.arguments?.videoName as string) ?? `flow-${Date.now()}`;
    const results: string[] = [];
    const vars: Record<string, any> = {};  // step outputs captured via {return:"name"}, referenced as {{name.path}}

    const screenshotDir = captureConfig.dir;
    ensureCaptureDir();
    const fmt = (d: Date) => d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');

    // Resolve which page to screenshot after a step
    async function resolveCapturePage(activePage: Page, capturedPage?: number | string): Promise<Page | null> {
        try {
            const b = browsers[profileName];
            if (!b || !b.isConnected()) return activePage;
            const pages = b.contexts().flatMap(c => c.pages());
            if (capturedPage === undefined) return activePage; // default: active tab
            if (typeof capturedPage === 'number') return pages[capturedPage] ?? activePage;
            // string: URL substring match
            return pages.find(pg => pg.url().includes(capturedPage as string)) ?? activePage;
        } catch { return activePage; }
    }

    // Record mode: run the whole flow in a fresh Playwright-launched context (recordVideo isn't
    // honored over connectOverCDP). Login-free flows only. Saves a .webm to the capture dir.
    let recBrowser: any = null, recCtx: any = null, recPage: Page | null = null;
    if (recordVideo) {
        recBrowser = await repoPlaywright().launch({ headless: true });
        recCtx = await recBrowser.newContext({
            viewport: { width: 1280, height: 900 },
            recordVideo: { dir: screenshotDir, size: { width: 1280, height: 900 } },
        });
        recPage = await recCtx.newPage();
    }

    let p: Page | null = null;
    // Sticky active-tab selection (set by page.select); a per-step `onPage` overrides it for one step.
    let activeSel: number | string | undefined = undefined;

    // Screencast mode: record the ACTUAL CDP browser via Page.startScreencast (frames are
    // event-driven; ffmpeg resamples to constant `fps` at the end). Captures the real flow.
    let scSession: any = null;
    const scFrames: { buf: Buffer; ts: number }[] = [];
    // Attach a fresh screencast CDP session to `page`. Each frame handler acks on ITS OWN session
    // (closure over `sess`), so this is safe to call again mid-flow on a `screencast.switch` step.
    async function startScreencastOn(page: Page) {
        const sess = await page.context().newCDPSession(page);
        sess.on('Page.screencastFrame', async (f: any) => {
            try { scFrames.push({ buf: Buffer.from(f.data, 'base64'), ts: f.metadata?.timestamp ?? (Date.now() / 1000) }); } catch {}
            try { await sess.send('Page.screencastFrameAck', { sessionId: f.sessionId }); } catch {}
        });
        await sess.send('Page.startScreencast', { format: 'jpeg', quality: 80, everyNthFrame: 1 });
        return sess;
    }
    if (screencast) {
        const scPage = await getPage(profileName);
        p = scPage;
        scSession = await startScreencastOn(scPage);
    }

    for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const ts = fmt(new Date());
        try {
            const param = interpolate(step.param, vars);
            let result: any;
            if (step.method.startsWith('browser.') || step.method.startsWith('api_user.')) {
                result = await dispatch(null as any, step.method, param);
            } else if (step.method === 'page.select' && !recPage && !screencast) {
                // Switch the active tab for subsequent steps (sticky). param = index | URL-substring.
                activeSel = param;
                p = await getPage(profileName, activeSel);
                result = `Active tab → [${activeSel}] ${p.url()}`;
            } else if (step.method === 'screencast.switch') {
                // Switch WHICH page the screencast records, mid-flow. param = tab index | URL-substring.
                // Stops the current screencast session and re-attaches on the target page; frames keep
                // flowing into the same buffer, so the output mp4 is one continuous video across tabs.
                if (!screencast || !scSession) {
                    result = 'screencast.switch ignored (not in screencast mode)';
                } else {
                    const sel = (typeof param === 'string' && /^\d+$/.test(param)) ? Number(param) : param;
                    const target = await getPage(profileName, sel);
                    try { await scSession.send('Page.stopScreencast'); } catch {}
                    try { await scSession.detach(); } catch {}
                    p = target;
                    scSession = await startScreencastOn(target);
                    result = `screencast → [${sel}] ${target.url()}`;
                }
            } else {
                // Per-step onPage wins; else the sticky activeSel; else the default tab.
                const sel = step.onPage ?? activeSel;
                if (recPage) p = recPage;
                else if (screencast) { if (!p) p = await getPage(profileName); }
                else p = await getPage(profileName, sel);
                result = await dispatch(p, step.method, param);
                // Update active page if navigate opened/changed it (CDP only; record page persists)
                if (step.method === 'page.navigate' && !recPage && !screencast) {
                    try { p = await getPage(profileName, sel); } catch {}
                }
            }
            if (step.return) vars[step.return] = result;
            const shown = result === undefined ? 'ok' : (typeof result === 'string' ? result : JSON.stringify(result));
            let line = `[${ts}] ✓ ${step.method}: ${shown}`;
            // Screenshot: if explicitly requested per-step OR global screenshot=true (not for browser.* or last step)
            const shouldShot = !recPage && !screencast && (screenshot || step.capturedPage !== undefined) && p && !step.method.startsWith('browser.') && !step.method.startsWith('api_user.');
            if (shouldShot) {
                try {
                    const capPage = await resolveCapturePage(p!, step.capturedPage);
                    if (capPage) {
                        const shotPath = join(screenshotDir, `step-${i + 1}-${Date.now()}.png`);
                        await capPage.screenshot({ path: shotPath });
                        line += `\n  📷 ${shotPath}`;
                    }
                } catch {}
            }
            results.push(line);
        } catch (err: any) {
            results.push(`[${ts}] ✗ ${step.method}: ${err.message}`);
            break;
        }
    }

    if (recordVideo && recCtx) {
        let vpath = '';
        try {
            const vid = recPage ? recPage.video() : null;
            await recCtx.close();  // closing the context flushes the video file
            if (vid) {
                const orig = await vid.path();
                vpath = join(screenshotDir, `${videoName}.webm`);
                try { renameSync(orig, vpath); } catch { vpath = orig; }
            }
            results.push(`🎥 video saved: ${vpath}`);
        } catch (e: any) { results.push(`🎥 video error: ${e.message}`); }
        try { await recBrowser?.close(); } catch {}
    }

    if (screencast && scSession) {
        try { await scSession.send('Page.stopScreencast'); } catch {}
        try {
            if (scFrames.length === 0) {
                results.push('🎥 screencast: no frames captured');
            } else {
                const dir = join(screenshotDir, `_sc_${Date.now()}`);
                mkdirSync(dir, { recursive: true });
                const list: string[] = [];
                for (let k = 0; k < scFrames.length; k++) {
                    const fn = join(dir, `f${String(k).padStart(5, '0')}.jpg`);
                    writeFileSync(fn, scFrames[k].buf);
                    const dur = k < scFrames.length - 1 ? Math.max(scFrames[k + 1].ts - scFrames[k].ts, 0.001) : 1 / fps;
                    list.push(`file '${fn}'`, `duration ${dur.toFixed(3)}`);
                }
                list.push(`file '${join(dir, `f${String(scFrames.length - 1).padStart(5, '0')}.jpg`)}'`);
                const listFile = join(dir, 'list.txt');
                writeFileSync(listFile, list.join('\n'));
                const out = join(screenshotDir, `${videoName}.mp4`);
                const ff = existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg';
                execFileSync(ff, ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-vf', `fps=${fps},format=yuv420p`, '-c:v', 'libx264', '-preset', 'veryfast', '-movflags', '+faststart', out], { stdio: 'ignore' });
                rmSync(dir, { recursive: true, force: true });
                results.push(`🎥 video saved: ${out} (${scFrames.length} frames @ ${fps}fps)`);
            }
        } catch (e: any) { results.push(`🎥 screencast error: ${e.message}`); }
    }

    return { content: [{ type: 'text', text: results.join('\n') }] };
});

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch(console.error);

/**
 * sillytavern-lab — the single source of truth for every test script you write.
 *
 * ── What this is ──────────────────────────────────────────────────────────────
 * SillyTavern already ships everything needed to run a *second*, isolated
 * instance: `--port`, `--dataRoot`, `--configPath`. What it does not ship is a
 * convention for using that safely, every day, across several extension
 * projects at once. This module is that convention.
 *
 * ── The three layers of isolation ─────────────────────────────────────────────
 *   install dir  <ST_INSTALL>/public/                     SHARED  (same files)
 *   data root    <lab>/.runtime/data/                     ISOLATED (chats, cards,
 *                                                                  worlds,
 *                                                                  settings.json,
 *                                                                  _webpack)
 *   extensions   <dataRoot>/default-user/extensions/      ISOLATED, and a plugin
 *                                                         here SHADOWS the
 *                                                         globally installed one
 *                                                         with the same name
 *
 * The third layer is the one that matters day to day: your half-finished
 * extension only loads inside the lab, so you can keep *using* SillyTavern
 * normally on the stable copy while you break things in the lab.
 *
 * ── Usage ─────────────────────────────────────────────────────────────────────
 *     import { ST_URL, MOCK_PORT, assertLabUp, withHarnessLock } from '../lab/lab-env.mjs';
 *
 * Every value can be overridden by `lab.config.json` and then by an environment
 * variable, so the same scripts work on someone else's machine.
 */

import { existsSync, readFileSync, writeFileSync, rmSync, copyFileSync, mkdirSync, openSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

// ───────────────────────────────── config file ─────────────────────────────────

/** Directory this module lives in — i.e. the lab directory. */
export const LAB_DIR = dirname(fileURLToPath(import.meta.url));

/** Where the user config lives. Override with LAB_CONFIG_FILE. */
export const CONFIG_FILE = process.env.LAB_CONFIG_FILE ?? join(LAB_DIR, 'lab.config.json');

/** Example config, copied over CONFIG_FILE on first run when missing. */
export const CONFIG_EXAMPLE_FILE = join(LAB_DIR, 'lab.config.example.json');

/**
 * Strip `//` and block comments, then trailing commas, from a JSONC document.
 *
 * Done with a state machine rather than a regex because the naive version
 * corrupts any string containing `//` — and `"stInstall": "D://sillytavern"`
 * is exactly the kind of value this file holds. The comment markers are only
 * honoured outside of string literals.
 */
function parseJsonc(text) {
    let out = '';
    let inString = false;
    let inLine = false;
    let inBlock = false;
    let escaped = false;

    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        const next = text[i + 1];

        if (inLine) {
            if (c === '\n') {
                inLine = false;
                out += c;
            }
            continue;
        }
        if (inBlock) {
            if (c === '*' && next === '/') {
                inBlock = false;
                i++;
            }
            continue;
        }
        if (inString) {
            out += c;
            if (escaped) escaped = false;
            else if (c === '\\') escaped = true;
            else if (c === '"') inString = false;
            continue;
        }
        if (c === '"') {
            inString = true;
            out += c;
            continue;
        }
        if (c === '/' && next === '/') {
            inLine = true;
            i++;
            continue;
        }
        if (c === '/' && next === '*') {
            inBlock = true;
            i++;
            continue;
        }
        out += c;
    }

    // Second pass: drop a comma that is only followed by whitespace and a closer.
    let clean = '';
    inString = false;
    escaped = false;
    for (let i = 0; i < out.length; i++) {
        const c = out[i];
        if (inString) {
            clean += c;
            if (escaped) escaped = false;
            else if (c === '\\') escaped = true;
            else if (c === '"') inString = false;
            continue;
        }
        if (c === '"') {
            inString = true;
            clean += c;
            continue;
        }
        if (c === ',') {
            let j = i + 1;
            while (j < out.length && /\s/.test(out[j])) j++;
            if (out[j] === '}' || out[j] === ']') continue;
        }
        clean += c;
    }

    return JSON.parse(clean);
}

/** Read lab.config.json (JSONC, optional). Missing file = all defaults. */
function readUserConfig() {
    if (!existsSync(CONFIG_FILE)) return {};

    const text = readFileSync(CONFIG_FILE, 'utf8');
    try {
        const parsed = parseJsonc(text);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('top level must be an object');
        }
        return parsed;
    } catch (error) {
        throw new Error(
            `${CONFIG_FILE} is not valid JSON: ${error?.message ?? error}\n` +
            `Fix it, or delete it and a fresh copy of lab.config.example.json will be used.`,
        );
    }
}

const USER_CONFIG = readUserConfig();

/**
 * Test leftovers to reclaim, as configured in lab.config.json.
 *
 * Consumed by `lab.mjs clean`. Rules are plain data (name patterns per
 * directory) rather than code, so the same tool works for anyone's fixtures.
 */
export const RESIDUE = USER_CONFIG.residue ?? {};

/** Read a config value: env var first, then the config file, then the default. */
function setting(envName, configKey, fallback) {
    const fromEnv = process.env[envName];
    if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
    if (configKey !== null) {
        const fromFile = USER_CONFIG[configKey];
        if (fromFile !== undefined && fromFile !== null && fromFile !== '') return fromFile;
    }
    return fallback;
}

// ───────────────────────────────── paths ─────────────────────────────────

/**
 * Locate the SillyTavern checkout.
 *
 * Order: LAB_ST_INSTALL → config `stInstall` → a few conventional neighbours.
 * A directory only counts if it actually contains ST's `server.js`, so a wrong
 * guess degrades into a clear error message instead of a confusing crash later.
 */
function detectStInstall() {
    const candidates = [];
    const explicit = setting('LAB_ST_INSTALL', 'stInstall', null);
    if (explicit) candidates.push(explicit);

    candidates.push(
        join(LAB_DIR, '..', 'SillyTavern'),
        join(LAB_DIR, '..', 'sillytavern'),
        join(LAB_DIR, 'SillyTavern'),
        join(process.cwd(), 'SillyTavern'),
        join(homedir(), 'SillyTavern'),
        'D:\\sillytavern',
    );

    for (const candidate of candidates) {
        if (!candidate) continue;
        const dir = resolve(String(candidate));
        if (existsSync(join(dir, 'server.js'))) return dir;
    }

    if (explicit) {
        // They told us where it is; say why that is not usable rather than "not found".
        const dir = resolve(String(explicit));
        throw new Error(
            `stInstall points at ${dir}, but there is no server.js there.\n` +
            `Point it at the SillyTavern checkout that contains server.js (not at its data/ folder).`,
        );
    }

    throw new Error(
        `Could not find your SillyTavern install.\n` +
        `Set it in ${CONFIG_FILE} ("stInstall": "C:\\\\path\\\\to\\\\SillyTavern") ` +
        `or with the LAB_ST_INSTALL environment variable.`,
    );
}

/**
 * ST checkout (contains server.js).
 *
 * Resolved lazily: `status`, `clean` and the usage text have no reason to care
 * where SillyTavern lives, and a moved checkout should not make them explode.
 */
let resolvedStInstall;
export function stInstall() {
    if (resolvedStInstall === undefined) resolvedStInstall = detectStInstall();
    return resolvedStInstall;
}

/**
 * Lab-private runtime state: generated config, pid, lock, log, data root.
 *
 * Relocate it (config `runtimeDir`, env `LAB_RUNTIME_DIR`) to run a second,
 * fully independent lab — which is how `verify.mjs` avoids touching the state of
 * the lab you are actually using.
 */
export const RUNTIME_DIR = resolve(String(setting('LAB_RUNTIME_DIR', 'runtimeDir', join(LAB_DIR, '.runtime'))));

/**
 * Lab-private data root — chats, characters, worlds, settings.json and
 * `_webpack` all live under here, and none of it is your real data.
 */
export const DATA_ROOT = resolve(String(setting('LAB_DATA_ROOT', 'dataRoot', join(RUNTIME_DIR, 'data'))));

/**
 * The `config.yaml` handed to the lab instance.
 *
 * If it does not exist yet it is copied from ST's own config (see
 * `ensureLabConfig`), so the lab starts out matching your real settings and
 * picks up new upstream defaults automatically instead of rotting.
 */
export const CONFIG_PATH = resolve(String(setting('LAB_CONFIG_PATH', 'configPath', join(RUNTIME_DIR, 'config.yaml'))));

/** ST entry script, relative to ST_INSTALL. */
export const SERVER_ENTRY = 'server.js';

/** Lab server output. */
export const LOG_PATH = join(RUNTIME_DIR, 'server.log');

/** PID of the detached lab process, when started with `start`. */
export const PID_PATH = join(RUNTIME_DIR, '.lab.pid');

/**
 * Advisory lock. Note this is a *single* lock file for the whole lab, not one
 * per name: two test scripts must never share one data root concurrently, so
 * mutual exclusion is deliberately global. The name is only recorded for the
 * error message.
 */
export const LOCK_PATH = join(RUNTIME_DIR, '.harness.lock');

/** Extensions only the lab can see. On a name clash these shadow the global ones. */
export const LAB_EXTENSIONS_DIR = join(DATA_ROOT, 'default-user', 'extensions');

/** Extensions both instances load (a symlink here is how you "install" for real). */
export function globalExtensionsDir() {
    return join(stInstall(), 'public', 'scripts', 'extensions', 'third-party');
}

/** Where the lab instance keeps lorebooks. */
export const WORLDS_DIR = join(DATA_ROOT, 'default-user', 'worlds');

/** The single user profile inside the lab data root. */
export const USER_DIR = join(DATA_ROOT, 'default-user');

// ───────────────────────────────── ports ─────────────────────────────────

function positiveInt(value, fallback, what) {
    if (value === null || value === undefined || value === '') return fallback;
    const n = Number(value);
    if (Number.isInteger(n) && n > 0 && n < 65536) return n;
    throw new Error(`${what} must be a port number between 1 and 65535, got ${JSON.stringify(value)}`);
}

/** Ports, from config `ports` (or the flat env vars). */
const PORTS = USER_CONFIG.ports ?? {};

export const ST_PORT = positiveInt(setting('LAB_ST_PORT', null, PORTS.st ?? 8011), 8011, 'ports.st');
export const MOCK_PORT = positiveInt(setting('LAB_MOCK_PORT', null, PORTS.mock ?? 8123), 8123, 'ports.mock');
export const CDP_PORT = positiveInt(setting('LAB_CDP_PORT', null, PORTS.cdp ?? 9333), 9333, 'ports.cdp');

/**
 * CDP port for a numbered slot.
 *
 * A browser automation script needs its own debugging port, but hardcoding
 * `9333 + n` in every script is how you eventually get two scripts fighting
 * over one port. Ask for a slot instead.
 */
export function cdpPort(slot = 0) {
    const n = Number(slot);
    if (!Number.isInteger(n) || n < 0) throw new Error(`cdpPort slot must be a non-negative integer, got ${slot}`);
    return CDP_PORT + n;
}

/** Lab base URL. */
export const ST_URL = process.env.LAB_ST_URL || String(setting('LAB_ST_URL', 'stUrl', `http://127.0.0.1:${ST_PORT}/`));

/** OpenAI-compatible mock server base URL (point ST's Custom/OpenAI reverse proxy here). */
export const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}/v1`;

/** Should the lab instance accept non-local connections? Off by default, on purpose. */
const LISTEN = USER_CONFIG.listen === true;

/** Should starting the lab pop open a browser window? Off by default. */
const BROWSER_LAUNCH = USER_CONFIG.browserLaunch === true;

/**
 * `config.yaml` settings forced on top of the copied ST config.
 *
 * SillyTavern documents `SILLYTAVERN_<UPPERCASE_KEY>` environment variables
 * that override the file, including nested keys joined with underscores — which
 * is how we turn off the on-disk character cache without having to write YAML.
 */
function overrideEnv() {
    const configured = USER_CONFIG.overrides ?? {};
    const env = {};
    for (const [key, value] of Object.entries(configured)) {
        const name = 'SILLYTAVERN_' + key.split('.').join('_').toUpperCase();
        env[name] = typeof value === 'object' ? JSON.stringify(value) : String(value);
    }
    return env;
}

/** Environment for the lab process: inherited env plus the configured overrides. */
export function serverEnv() {
    return { ...process.env, ...overrideEnv() };
}

/** Arguments for the lab process. Absolute paths — a relative --dataRoot is resolved against the install dir. */
export function serverArgs() {
    return [
        SERVER_ENTRY,
        '--port', String(ST_PORT),
        '--dataRoot', DATA_ROOT,
        '--configPath', CONFIG_PATH,
        '--listen', LISTEN ? 'true' : 'false',
        '--browserLaunchEnabled', BROWSER_LAUNCH ? 'true' : 'false',
    ];
}

/** One-line fix-it hint used by every "lab is not running" error. */
export function startHint() {
    return `The lab is not running. Start it with: node "${join(LAB_DIR, 'lab.mjs')}" start`;
}

// ───────────────────────────────── lifecycle ─────────────────────────────────

/** The config ST ships, used as the template for the lab's own config.yaml. */
function configBase() {
    const configured = USER_CONFIG.configBase;
    if (configured) {
        const p = resolve(String(configured));
        if (!existsSync(p)) throw new Error(`configBase points at ${p}, which does not exist.`);
        return p;
    }
    const live = join(stInstall(), 'config.yaml');
    if (existsSync(live)) return live;
    const shipped = join(stInstall(), 'default', 'config.yaml');
    if (existsSync(shipped)) return shipped;
    return null;
}

/**
 * Make sure the lab has a `config.yaml`, copying it from ST on first run.
 *
 * Copying rather than hand-writing a template is deliberate: a hand-written
 * config goes stale the moment upstream adds a setting, and the failure mode
 * (a silently missing default) is hard to notice.
 *
 * @returns {{path: string, created: boolean, base: string|null}}
 */
export function ensureLabConfig() {
    if (existsSync(CONFIG_PATH)) return { path: CONFIG_PATH, created: false, base: null };

    const base = configBase();
    if (!base) {
        throw new Error(
            `No config.yaml found in your SillyTavern install (looked for config.yaml and default/config.yaml).\n` +
            `Start SillyTavern once so it generates one, or set "configBase" in ${CONFIG_FILE}.`,
        );
    }

    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    copyFileSync(base, CONFIG_PATH);
    return { path: CONFIG_PATH, created: true, base };
}

/** Throw unless ST's entry script is where we think it is. */
export function assertServerEntry() {
    const entry = join(stInstall(), SERVER_ENTRY);
    if (!existsSync(entry)) {
        throw new Error(`ST entry script not found: ${entry} (is LAB_ST_INSTALL wrong?)`);
    }
    return entry;
}

/**
 * Start the lab as a detached background process.
 *
 * The log is opened as a file descriptor and passed as stdio rather than piped,
 * because piping means the parent must keep draining it — and a parent that
 * exits (or a restricted environment) makes `spawn` fail in ways that look
 * nothing like "my log pipe is full".
 */
export function spawnLabServer() {
    assertServerEntry();
    const config = ensureLabConfig();

    const log = openSync(LOG_PATH, 'a');
    const proc = spawn(process.execPath, serverArgs(), {
        cwd: stInstall(),
        env: serverEnv(),
        detached: true,
        stdio: ['ignore', log, log],
    });
    proc.unref();

    writeFileSync(PID_PATH, String(proc.pid));
    return { pid: proc.pid, config };
}

// ───────────────────────────────── liveness ─────────────────────────────────

/**
 * Is the lab answering HTTP right now?
 *
 * Deliberately an HTTP probe rather than a port check: a socket can accept a
 * connection long before the server can serve a page, and `Get-NetTCPConnection`
 * on Windows misses listeners that `netstat` reports.
 */
export async function isLabUp(timeoutMs = 2500) {
    try {
        const res = await fetch(ST_URL, { signal: AbortSignal.timeout(timeoutMs) });
        return res.ok;
    } catch {
        return false;
    }
}

/** Poll until the lab answers. Resolves with the elapsed milliseconds. */
export async function waitForLabUp({ timeoutMs = 180000, intervalMs = 500 } = {}) {
    const t0 = Date.now();
    for (;;) {
        if (await isLabUp()) return Date.now() - t0;
        if (Date.now() - t0 > timeoutMs) {
            throw new Error(`Timed out after ${timeoutMs}ms waiting for the lab at ${ST_URL}. ${startHint()}`);
        }
        await new Promise(r => setTimeout(r, intervalMs));
    }
}

/** Throw a fix-it error unless the lab is reachable. */
export async function assertLabUp() {
    if (!await isLabUp()) {
        throw new Error(`Cannot reach the lab at ${ST_URL}. ${startHint()}`);
    }
}

/** PID recorded by `start`, or null when absent/unreadable. */
export function readPid() {
    try {
        const pid = Number(readFileSync(PID_PATH, 'utf8').trim());
        return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch {
        return null;
    }
}

/** Is this process still alive? A process we cannot signal still counts as alive. */
export function isAlive(pid) {
    if (!pid) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error?.code === 'EPERM';
    }
}

/** True when the path exists *and* is a directory, following symlinks. */
export function isDirectory(p) {
    try {
        return statSync(p).isDirectory();
    } catch {
        return false;
    }
}

// ───────────────────────────────── concurrency lock ─────────────────────────────────
//
// Why this exists: two test scripts sharing one data root corrupt each other in
// ways that do not look like corruption. settings.json overwrites settings.json,
// one script's fixture cleanup deletes the other's fixture, and `_webpack` gets
// written concurrently. The symptom is a flaky assertion failure in whichever
// script happens to lose, which is the worst possible bug to debug.

/**
 * Take the lab lock, run `fn`, release it. The normal way to use the lock.
 *
 *     await withHarnessLock('myplugin-driver', async () => { ... });
 */
export async function withHarnessLock(name, fn) {
    acquireLock(name);
    try {
        return await fn();
    } finally {
        releaseLock();
    }
}

/**
 * Take the lock without releasing it — for scripts that are one long top-level
 * await and simply call `process.on('exit', releaseLock)`.
 *
 * Prefer `withHarnessLock`; use this pair only when there is no single scope to
 * wrap. A lock whose owner process died is taken over automatically, so a
 * Ctrl-C'd run never wedges the lab.
 */
export function acquireLock(name) {
    const payload = JSON.stringify({ name, pid: process.pid, at: new Date().toISOString() });
    mkdirSync(dirname(LOCK_PATH), { recursive: true });

    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            writeFileSync(LOCK_PATH, payload, { flag: 'wx' });
            return;
        } catch (error) {
            if (error?.code !== 'EEXIST') throw error;

            const holder = readLock();
            if (holder && !isAlive(holder.pid)) {
                rmSync(LOCK_PATH, { force: true });   // stale lock from a killed run
                continue;
            }

            const who = holder ? `${holder.name} (pid ${holder.pid}, started ${holder.at})` : 'an unknown process';
            throw new Error(
                `The lab is busy: ${who}\n` +
                `Two test scripts must not share one data root (${DATA_ROOT}).\n` +
                `Wait for it to finish; if you are sure it is dead, delete ${LOCK_PATH}`,
            );
        }
    }

    throw new Error(`Could not acquire the lab lock: ${LOCK_PATH}`);
}

/** Release the lock, but only if we are the holder. */
export function releaseLock() {
    const holder = readLock();
    if (holder && holder.pid !== process.pid) return;
    rmSync(LOCK_PATH, { force: true });
}

/** Lock contents, or null when unlocked/unreadable. */
export function readLock() {
    try {
        return JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
    } catch {
        return null;
    }
}

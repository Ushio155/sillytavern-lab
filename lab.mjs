#!/usr/bin/env node
/**
 * sillytavern-lab CLI.
 *
 *   node lab.mjs start      start in the background (no-op when already running)
 *   node lab.mjs run        run in the foreground, logs in this terminal
 *   node lab.mjs stop       stop it
 *   node lab.mjs restart    stop, then start
 *   node lab.mjs status     is it running? exit code 0 = yes, 1 = no
 *   node lab.mjs info       what would the lab load, and where is its data?
 *   node lab.mjs link <name> <extension source dir>
 *                           expose an extension to the lab only (your real
 *                           SillyTavern cannot see it, and it shadows a global
 *                           extension with the same folder name)
 *   node lab.mjs unlink <name>
 *                           remove that link (never touches your source)
 *   node lab.mjs clean [--dry-run] [--yes]
 *                           reclaim test leftovers; dry-run unless --yes
 *
 * Runtime state lives in .runtime/ (log, pid, lock, generated config, data).
 *
 * One data root can only serve one lab process. To stop two test scripts from
 * colliding, wrap them in lab-env.mjs's withHarnessLock().
 */

import {
    existsSync, readdirSync, symlinkSync, rmSync, statSync, lstatSync, mkdirSync,
    openSync, closeSync, readFileSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join, basename, resolve, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import {
    LAB_DIR, CONFIG_FILE, RUNTIME_DIR, DATA_ROOT, CONFIG_PATH, ST_PORT, ST_URL,
    MOCK_PORT, CDP_PORT, LAB_EXTENSIONS_DIR, WORLDS_DIR, USER_DIR,
    LOG_PATH, PID_PATH, LOCK_PATH, SERVER_ENTRY, stInstall, globalExtensionsDir,
    isLabUp, waitForLabUp, readPid, isAlive, readLock, spawnLabServer, serverArgs, serverEnv,
    startHint, ensureLabConfig, RESIDUE,
} from './lab-env.mjs';

const [action, ...rest] = process.argv.slice(2);

// ───────────────────────────────── small helpers ─────────────────────────────────

/**
 * List subdirectory names, tolerating broken entries.
 *
 * Entries are inspected one by one on purpose: a `link` whose source directory
 * was renamed becomes a dangling symlink, and a single `statSync` over the whole
 * directory throws on that one entry — which would silently turn the *entire*
 * listing into "empty". Dangling links get labelled instead of disappearing.
 */
function subdirs(dir) {
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        return [];
    }

    const names = [];
    for (const entry of entries) {
        const full = join(dir, entry.name);
        try {
            const info = lstatSync(full);
            if (info.isSymbolicLink()) {
                try {
                    if (!statSync(full).isDirectory()) continue;   // link to a non-directory
                } catch {
                    names.push(`${entry.name} (dangling: target is gone)`);
                    continue;
                }
                names.push(entry.name);
                continue;
            }
            if (info.isDirectory()) names.push(entry.name);
        } catch {
            // One unreadable entry must never discard the whole listing.
        }
    }
    return names;
}

/**
 * lstat that reports "exists" for dangling symlinks too.
 *
 * `existsSync` follows links, so it answers false for a dangling junction —
 * which is exactly the case where we must *not* assume the path is free.
 */
function lstatOrNull(p) {
    try {
        return lstatSync(p);
    } catch {
        return null;
    }
}

/**
 * Accept only a single directory name.
 *
 * `join()` normalises `..` away, so without this check `unlink ..` would delete
 * a directory outside the extensions folder.
 */
function isPlainName(name) {
    if (typeof name !== 'string' || name === '' || name === '.' || name === '..') return false;
    if (name.includes('/') || name.includes('\\')) return false;
    return basename(name) === name;
}

/**
 * Run a command with its output redirected to a temp file, and return the text.
 *
 * Not piped on purpose: a piped child needs the parent to keep draining it, and
 * in restricted environments creating the pipe itself fails. Returns null when
 * the command is unavailable — every caller treats this as best effort.
 */
function runToFile(command, args) {
    const file = join(tmpdir(), `lab-probe-${process.pid}-${Math.random().toString(36).slice(2)}.txt`);
    try {
        const fd = openSync(file, 'w');
        try {
            spawnSync(command, args, { stdio: ['ignore', fd, 'ignore'], windowsHide: true });
        } finally {
            closeSync(fd);
        }
        return readFileSync(file, 'utf8');
    } catch {
        return null;
    } finally {
        rmSync(file, { force: true });
    }
}

/** PID listening on a TCP port, for diagnostics only. Null when we cannot tell. */
function findPidOnPort(port) {
    if (process.platform === 'win32') {
        const text = runToFile('netstat', ['-ano']);
        if (!text) return null;
        for (const line of text.split(/\r?\n/)) {
            const cols = line.trim().split(/\s+/);
            if (cols.length < 5) continue;
            if (cols[0].toUpperCase() !== 'TCP' || cols[3].toUpperCase() !== 'LISTENING') continue;
            const portMatch = cols[1].match(/:(\d+)$/);
            if (!portMatch || Number(portMatch[1]) !== Number(port)) continue;
            const pid = Number(cols[4]);
            if (Number.isInteger(pid) && pid > 0) return pid;
        }
        return null;
    }

    // Linux/macOS: lsof is the most portable, ss is the usual fallback.
    const lsof = runToFile('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN']);
    if (lsof) {
        const pid = Number(lsof.split('\n').map(s => s.trim()).find(Boolean));
        if (Number.isInteger(pid) && pid > 0) return pid;
    }
    const ss = runToFile('ss', ['-ltnp']);
    if (ss) {
        for (const line of ss.split('\n')) {
            if (!new RegExp(`[:.]${port}\\s`).test(line)) continue;
            const m = line.match(/pid=(\d+)/);
            if (m) return Number(m[1]);
        }
    }
    return null;
}

/** The command that force-kills a PID on this platform. */
function killHint(pid) {
    return process.platform === 'win32' ? `taskkill /PID ${pid} /F` : `kill ${pid}`;
}

// ───────────────────────────────── clean ─────────────────────────────────
//
// clean only ever deletes regular files whose *name* matches a pattern you
// configured, and only outside the protected list. It never recurses, never
// follows symlinks, and never guesses that something "looks like junk".

/** Path comparison key: absolute, and case-insensitive on Windows. */
function normKey(p) {
    const abs = resolve(p);
    return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

/** Path relative to the lab directory, for readable output. */
function rel(p) {
    const r = relative(LAB_DIR, resolve(p));
    return r && !r.startsWith('..') ? r : resolve(p);
}

function fmtBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MiB`;
}

/** Residue configuration: lab-env.mjs owns parsing and validation of the file. */
const RESIDUE_CONFIG = RESIDUE;

/** Resolve a residue entry's directory. */
function ruleDir(entry) {
    const base = entry.root === 'dataRoot' ? DATA_ROOT : USER_DIR;
    if (typeof entry.dir !== 'string' || entry.dir === '') {
        throw new Error(`residue rule is missing "dir": ${JSON.stringify(entry)}`);
    }
    const dir = resolve(base, entry.dir);
    // A rule must not escape the data root.
    const rootKey = normKey(DATA_ROOT);
    if (normKey(dir) !== rootKey && !normKey(dir).startsWith(rootKey + sep)) {
        throw new Error(`residue rule points outside the data root: ${JSON.stringify(entry)}`);
    }
    return dir;
}

/** Compile the configured rules once, with errors that name the offending rule. */
function compileRules() {
    const entries = RESIDUE_CONFIG.rules ?? [];
    if (!Array.isArray(entries)) throw new Error('residue.rules must be an array');

    return entries.map(entry => {
        if (typeof entry.pattern !== 'string') {
            throw new Error(`residue rule is missing "pattern": ${JSON.stringify(entry)}`);
        }
        let re;
        try {
            re = new RegExp(entry.pattern);
        } catch (error) {
            throw new Error(`residue rule has an invalid regex ${JSON.stringify(entry.pattern)}: ${error?.message ?? error}`);
        }
        return {
            dir: ruleDir(entry),
            what: entry.label ?? `${entry.root === 'dataRoot' ? '' : 'default-user/'}${entry.dir}`,
            match: name => (re.test(name) ? (entry.reason ?? 'matched a configured residue pattern') : null),
        };
    });
}

/** Files and directories clean refuses to touch. */
function protectedEntries() {
    const entries = [
        [join(WORLDS_DIR, 'Eldoria.json'), "SillyTavern's bundled sample lorebook"],
        [join(USER_DIR, 'characters', 'default_Seraphina.png'), "SillyTavern's bundled sample character"],
        [join(USER_DIR, 'characters', 'Seraphina'), "sample character's expression sprites (whole directory)"],
        [join(USER_DIR, 'settings.json'), 'lab settings (firstRun state, fixtures)'],
        [join(LAB_DIR, 'lab.mjs'), 'the lab CLI itself'],
        [join(LAB_DIR, 'lab-env.mjs'), 'the lab interface'],
        [join(LAB_DIR, 'lab.config.json'), 'your lab config'],
        [join(LAB_DIR, 'README.md'), 'the lab documentation'],
    ];

    for (const entry of RESIDUE_CONFIG.protect ?? []) {
        const base = entry.root === 'dataRoot' ? DATA_ROOT : USER_DIR;
        if (typeof entry.path !== 'string' || entry.path === '') {
            throw new Error(`residue.protect entry is missing "path": ${JSON.stringify(entry)}`);
        }
        entries.push([resolve(base, entry.path), entry.note ?? 'protected by lab.config.json']);
    }

    return entries;
}

/**
 * Everything clean would delete. Read-only.
 *
 * @returns {{targets: Array<{path:string,bytes:number,reason:string}>, protectedList: Array<{path:string,note:string,exists:boolean}>, notes: string[], warnings: string[]}}
 */
function collectCleanTargets() {
    const protectedList = protectedEntries().map(([p, note]) => ({ path: p, note, exists: !!lstatOrNull(p) }));
    const protectedFiles = new Set(protectedEntries().map(([p]) => normKey(p)));
    const protectedDirs = [join(USER_DIR, 'characters', 'Seraphina')].map(normKey);
    const dataRootKey = normKey(DATA_ROOT);

    const isProtected = p => {
        const key = normKey(p);
        if (protectedFiles.has(key)) return true;
        return protectedDirs.some(dir => key === dir || key.startsWith(dir + sep));
    };

    const targets = [];
    const notes = [];
    const warnings = [];

    // 1) Configured name-pattern rules.
    const rules = compileRules();
    if (rules.length === 0) {
        notes.push(`no residue rules configured — add some to ${basename(CONFIG_FILE)} (see lab.config.example.json)`);
    }
    for (const rule of rules) {
        let entries;
        try {
            entries = readdirSync(rule.dir, { withFileTypes: true });
        } catch {
            notes.push(`${rule.what}: directory does not exist, skipped`);
            continue;
        }

        let matched = 0;
        let unmatched = 0;
        for (const entry of entries) {
            const full = join(rule.dir, entry.name);
            const reason = rule.match(entry.name);
            if (!reason) {
                unmatched++;
                continue;
            }
            if (isProtected(full)) {
                warnings.push(`${rel(full)} matched a pattern but is protected → skipped`);
                continue;
            }
            const info = lstatOrNull(full);
            // Regular files only: never a directory, never a link.
            if (!info || !info.isFile()) {
                unmatched++;
                continue;
            }
            targets.push({ path: full, bytes: info.size, reason });
            matched++;
        }
        notes.push(`${rule.what}: ${matched} matched, ${unmatched} unmatched (skipped)`);
    }

    // 2) Stale character cache. Keys look like `<absolute path>-<mtimeMs>`; an
    //    entry whose target file is gone is dead weight SillyTavern never reclaims.
    const cacheDir = join(DATA_ROOT, '_cache', 'characters');
    let stale = 0;
    let live = 0;
    let unknown = 0;
    let cacheEntries = [];
    try {
        cacheEntries = readdirSync(cacheDir, { withFileTypes: true });
    } catch {
        notes.push('_cache/characters: directory does not exist, skipped');
    }
    for (const entry of cacheEntries) {
        const full = join(cacheDir, entry.name);
        const info = lstatOrNull(full);
        if (!info || !info.isFile()) {
            unknown++;
            continue;
        }

        let key = '';
        try {
            key = String(JSON.parse(readFileSync(full, 'utf8'))?.key ?? '');
        } catch {
            unknown++;
            continue;
        }

        // Split on the *last* dash: the mtime may be fractional, so guessing by
        // splitting on the first one (or on a `.`) gets it wrong.
        const dash = key.lastIndexOf('-');
        const targetPath = dash > 0 ? key.slice(0, dash) : '';
        const mtimePart = dash > 0 ? key.slice(dash + 1) : '';
        if (!targetPath || !/^\d+(\.\d+)?$/.test(mtimePart)) {
            unknown++;
            continue;
        }
        // Only judge entries that belong to this data root; a key pointing
        // elsewhere (e.g. a lab that moved) is left alone.
        if (!normKey(targetPath).startsWith(dataRootKey + sep)) {
            unknown++;
            warnings.push(`${rel(full)}: key points outside this data root (${targetPath}) → skipped`);
            continue;
        }
        if (lstatOrNull(targetPath)) {
            live++;
            continue;
        }

        targets.push({
            path: full,
            bytes: info.size,
            reason: `stale character cache: ${basename(targetPath)} is gone (SillyTavern never reclaims these)`,
        });
        stale++;
    }
    notes.push(`_cache/characters: ${stale} stale, ${live} live, ${unknown} undecidable`);

    return { targets, protectedList, notes, warnings };
}

/** `clean`: list leftovers by default, delete only with --yes. */
function clean(argv) {
    const args = argv ?? [];
    const dryRunFlag = args.includes('--dry-run');
    const yesFlag = args.includes('--yes');
    const unknownArgs = args.filter(a => a !== '--yes' && a !== '--dry-run');
    if (unknownArgs.length) {
        console.error(`Unknown argument(s): ${unknownArgs.join(' ')}`);
        console.error('Usage: node lab.mjs clean [--dry-run] [--yes]');
        console.error('  Without --yes this is a dry run: it lists, and deletes nothing.');
        console.error('  Given both, --dry-run wins: it lists, and deletes nothing.');
        process.exitCode = 1;
        return;
    }

    // --dry-run is the read-only switch, so it has to beat --yes. A flag named
    // dry-run that can still delete is worse than no flag at all.
    const bothFlags = dryRunFlag && yesFlag;
    const yes = yesFlag && !dryRunFlag;

    let collected;
    try {
        collected = collectCleanTargets();
    } catch (error) {
        console.error(`Cannot read the residue configuration: ${error?.message ?? error}`);
        process.exitCode = 1;
        return;
    }
    const { targets, protectedList, notes, warnings } = collected;
    const totalBytes = targets.reduce((sum, t) => sum + t.bytes, 0);

    console.log(`=== lab.mjs clean${yes ? ' (--yes: will delete)' : ' (dry run: nothing will be touched)'} ===`);
    console.log(`dataRoot: ${DATA_ROOT}`);
    if (bothFlags) {
        console.log('Note: both --dry-run and --yes were given — treating this as a dry run.');
        console.log('      To actually delete: node lab.mjs clean --yes');
    }
    console.log('');

    if (targets.length === 0) {
        console.log('Nothing matched the configured residue patterns.');
    } else {
        console.log(`${yes ? 'Deleting' : 'Would delete'} (${targets.length} items, ${totalBytes} B = ${fmtBytes(totalBytes)}):`);
        for (const t of targets) {
            console.log(`  · ${rel(t.path)}`);
            console.log(`      ${t.bytes} B — ${t.reason}`);
        }
    }

    console.log('');
    console.log(`Total: ${targets.length} items / ${totalBytes} B (${fmtBytes(totalBytes)})`);
    console.log('');
    console.log('Protected, never deleted:');
    for (const p of protectedList) {
        console.log(`  · ${rel(p.path)}${p.exists ? '' : ' (not present)'} — ${p.note}`);
    }
    console.log('  Anything not matching a configured pattern is left alone: clean matches the');
    console.log('  list you gave it, it does not judge what "looks like junk".');

    if (notes.length) {
        console.log('');
        console.log('Scan detail:');
        for (const n of notes) console.log(`  · ${n}`);
    }
    if (warnings.length) {
        console.log('');
        console.log('Skipped, worth a look:');
        for (const w of warnings) console.log(`  · ${w}`);
    }

    if (!yes) {
        console.log('');
        console.log('That was a listing: no file was touched. When it looks right: node lab.mjs clean --yes');
        return;
    }

    console.log('');
    let removed = 0;
    let freed = 0;
    let failed = 0;
    for (const t of targets) {
        const info = lstatOrNull(t.path);
        if (!info || !info.isFile()) {
            failed++;
            console.error(`  skipped (no longer a regular file): ${rel(t.path)}`);
            continue;
        }
        try {
            rmSync(t.path, { force: true });
            removed++;
            freed += info.size;
        } catch (error) {
            failed++;
            console.error(`  failed to delete: ${rel(t.path)} — ${error?.message ?? error}`);
        }
    }
    console.log(`Deleted ${removed} items, freed ${freed} B (${fmtBytes(freed)})${failed ? `; ${failed} skipped/failed` : ''}.`);
    if (failed) process.exitCode = 1;
}

// ───────────────────────────────── lifecycle commands ─────────────────────────────────

async function start() {
    if (await isLabUp()) {
        console.log(`The lab is already running: ${ST_URL}`);
        return;
    }

    let started;
    try {
        started = spawnLabServer();
    } catch (error) {
        console.error(String(error?.message ?? error));
        process.exitCode = 1;
        return;
    }

    console.log(`Started the lab, pid=${started.pid}`);
    console.log(`  SillyTavern: ${stInstall()}`);
    console.log(`  dataRoot:    ${DATA_ROOT}`);
    console.log(`  command:     node ${serverArgs().join(' ')}`);
    console.log(`  log:         ${LOG_PATH}`);
    if (started.config.created) {
        console.log(`  config:      created ${started.config.path} from ${started.config.base}`);
    }

    try {
        const ms = await waitForLabUp();
        console.log(ms > 3000
            ? `Ready in ${(ms / 1000).toFixed(1)}s (most likely the first webpack build; later starts are much faster)`
            : `Ready in ${ms}ms`);
    } catch (error) {
        console.error(String(error?.message ?? error));
        console.error(`The last lines of the log should say why: tail -n 30 "${LOG_PATH}"`);
        process.exitCode = 1;
    }
}

/**
 * Is someone already managing a lab instance? Returns why, or null.
 *
 * All three checks matter, because "already running" has three shapes:
 *   1. ST_URL answers — the normal hot case;
 *   2. the pid in .lab.pid is alive — `start` writes the pid *before* the first
 *      webpack build, which can take minutes, so there is a long window where
 *      the URL is dead but the lab is very much being managed;
 *   3. something is listening on the port — the pid file was deleted, or the
 *      instance was launched by hand.
 */
async function runningLabReason() {
    if (await isLabUp()) return `ST_URL answers (${ST_URL})`;
    const pid = readPid();
    if (pid && isAlive(pid)) return `the pid in .lab.pid is alive (pid ${pid})`;
    const holder = findPidOnPort(ST_PORT);
    if (holder) return `port ${ST_PORT} is already listened on by pid ${holder}`;
    return null;
}

/**
 * Run in the foreground, logging to this terminal.
 *
 * For environments that reap detached children when the parent exits: agents in
 * sandboxes, CI, scheduled tasks. `start` looks like it worked there and then
 * the instance vanishes.
 */
async function run() {
    // Guard first: everything below deletes the pid file, which would erase the
    // record of a lab that is genuinely running.
    const busy = await runningLabReason();
    if (busy) {
        console.error(`The lab is already running: ${busy}`);
        console.error('`run` is for a foreground restart: stop it first (node lab.mjs stop, or Ctrl-C that process).');
        process.exitCode = 1;
        return;
    }

    // Same check spawnLabServer() makes, but before touching the pid file, so a
    // wrong LAB_ST_INSTALL reports itself instead of destroying state and then
    // dying on an unhandled spawn error.
    const entry = join(stInstall(), SERVER_ENTRY);
    if (!existsSync(entry)) {
        console.error(`ST entry script not found: ${entry} (is LAB_ST_INSTALL wrong?)`);
        process.exitCode = 1;
        return;
    }

    let createdConfig;
    try {
        createdConfig = ensureLabConfig();
    } catch (error) {
        console.error(String(error?.message ?? error));
        process.exitCode = 1;
        return;
    }

    rmSync(PID_PATH, { force: true });   // a foreground run owns no pid file
    console.log(`Running the lab in the foreground: ${ST_URL} (Ctrl-C to stop)`);
    if (createdConfig.created) {
        console.log(`  config: created ${createdConfig.path} from ${createdConfig.base}`);
    }

    const proc = spawn(process.execPath, serverArgs(), {
        cwd: stInstall(),
        env: serverEnv(),
        stdio: 'inherit',
    });
    const code = await new Promise(resolvePromise => {
        proc.on('error', error => {
            console.error(`Failed to start: ${error?.message ?? error}`);
            resolvePromise(1);
        });
        proc.on('exit', exitCode => resolvePromise(exitCode ?? 0));
    });
    process.exitCode = code ?? 0;
}

async function stop() {
    const pid = readPid();
    if (!pid || !isAlive(pid)) {
        if (await isLabUp()) {
            const holder = findPidOnPort(ST_PORT);
            console.log(`The pid file does not match, but ${ST_URL} answers: someone else started this.`);
            console.log(holder
                ? `  pid ${holder} is listening on ${ST_PORT}; to stop it: ${killHint(holder)}`
                : `  could not identify the pid on ${ST_PORT}; check with: ${process.platform === 'win32' ? `netstat -ano | findstr :${ST_PORT}` : `lsof -i tcp:${ST_PORT}`}`);
            console.log('  (lab.mjs will not kill a process it did not start and record)');
        } else {
            console.log('The lab was not running.');
        }
        rmSync(PID_PATH, { force: true });
        return;
    }

    process.kill(pid);
    for (let i = 0; i < 40; i++) {
        if (!isAlive(pid) && !await isLabUp(500)) break;
        await new Promise(r => setTimeout(r, 250));
    }
    rmSync(PID_PATH, { force: true });
    console.log(await isLabUp(500) ? 'The process died but the port still answers — take a look.' : `Stopped (pid ${pid}).`);
}

async function status() {
    const up = await isLabUp();
    const pid = readPid();
    console.log(`Lab: ${up ? 'running' : 'not running'}`);
    console.log(`  URL:      ${ST_URL}`);
    console.log(`  pid file: ${pid ? `${pid} (${isAlive(pid) ? 'alive' : 'stale, process is gone'})` : 'none'}`);
    console.log(`  dataRoot: ${DATA_ROOT}${existsSync(DATA_ROOT) ? '' : '  ← does not exist yet'}`);

    const lock = readLock();
    if (lock) {
        console.log(`  locked by: ${lock.name} (pid ${lock.pid}, ${isAlive(lock.pid) ? 'alive' : 'dead'}, since ${lock.at})`);
    }
    if (!up) console.log(`\n${startHint()}`);
    process.exitCode = up ? 0 : 1;
}

function info() {
    console.log(`Lab directory: ${LAB_DIR}`);
    console.log(`SillyTavern:   ${stInstallText()}`);
    console.log(`dataRoot:      ${DATA_ROOT}${existsSync(DATA_ROOT) ? '' : '  ← does not exist yet, run `start` once'}`);
    console.log(`config:        ${CONFIG_PATH}${existsSync(CONFIG_PATH) ? '' : '  ← generated on first start'}`);
    console.log(`lab config:    ${CONFIG_FILE}${existsSync(CONFIG_FILE) ? '' : '  ← not present, using defaults'}`);
    console.log(`ports:         st ${ST_PORT} / mock ${MOCK_PORT} / cdp ${CDP_PORT}`);
    console.log(`lorebooks:     ${WORLDS_DIR}  (${existsSync(WORLDS_DIR) ? readdirSync(WORLDS_DIR).length : 0} files)`);

    const lab = subdirs(LAB_EXTENSIONS_DIR);
    console.log(`\nLab-only extensions (${LAB_EXTENSIONS_DIR}) — your real SillyTavern cannot see these:`);
    console.log(lab.length ? lab.map(n => `  · ${n}`).join('\n') : '  (none)');

    const global = subdirs(globalExtensionsDir());
    console.log(`\nGlobal extensions (${globalExtensionsDir()}) — shared with your real instance:`);
    console.log(global.length ? global.map(n => `  · ${n}`).join('\n') : '  (none)');
}

/** SillyTavern's location for `info`, or why we could not work it out. `info` should still print the rest. */
function stInstallText() {
    try {
        return stInstall();
    } catch (error) {
        return `<not found — ${error?.message ?? error}>`;
    }
}

function link(name, target) {
    if (!name || !target) {
        console.error('Usage: node lab.mjs link <name> <extension source dir>');
        process.exitCode = 1;
        return;
    }
    if (!isPlainName(name)) {
        console.error(`Invalid name: ${JSON.stringify(name)}`);
        console.error('Must be a single directory name (no / or \\, not . or .., not an absolute path) — e.g. SillyTavern-MyExtension.');
        process.exitCode = 1;
        return;
    }

    // The target must be a directory: linking to a file "succeeds" and then
    // silently does nothing, because SillyTavern never discovers it.
    const targetInfo = lstatOrNull(target);
    if (!targetInfo) {
        console.error(`Extension source directory does not exist: ${target}`);
        process.exitCode = 1;
        return;
    }
    let targetIsDir = targetInfo.isDirectory();
    if (!targetIsDir && targetInfo.isSymbolicLink()) {
        try {
            targetIsDir = statSync(target).isDirectory();
        } catch {
            targetIsDir = false;
        }
    }
    if (!targetIsDir) {
        console.error(`Extension source is not a directory: ${target}`);
        console.error(targetInfo.isSymbolicLink()
            ? '  (it is a link, but its target is missing or is not a directory)'
            : '  (it is a file; a link to a file is never discovered by SillyTavern)');
        process.exitCode = 1;
        return;
    }

    const dest = join(LAB_EXTENSIONS_DIR, name);
    // lstat, not existsSync: a dangling link reports "missing" and we would then
    // blow up later on an unhandled EEXIST.
    const existing = lstatOrNull(dest);
    if (existing) {
        console.error(existing.isSymbolicLink()
            ? `Already there: ${dest} (dangling or working link — unlink it first)`
            : `Already there: ${dest} (a real ${existing.isDirectory() ? 'directory' : 'file'}, not a link made by lab.mjs; unlink refuses to delete it)`);
        process.exitCode = 1;
        return;
    }

    mkdirSync(LAB_EXTENSIONS_DIR, { recursive: true });
    try {
        // A directory link needs no admin rights on Windows, and edits in your
        // source tree are visible to the lab immediately.
        symlinkSync(target, dest, 'junction');
    } catch (error) {
        console.error(`Failed to link: ${dest} -> ${target}`);
        console.error(`  ${error?.message ?? error}`);
        console.error('  If the target is on another drive or a network path, move it to a local directory and retry.');
        process.exitCode = 1;
        return;
    }
    console.log(`Linked: ${dest}  ->  ${target}`);
    console.log('Lab-only: your real SillyTavern (port 8000) cannot see it.');
}

function unlink(name) {
    if (!name) {
        console.error('Usage: node lab.mjs unlink <name>');
        process.exitCode = 1;
        return;
    }
    if (!isPlainName(name)) {
        console.error(`Invalid name: ${JSON.stringify(name)}`);
        console.error('Must be a single directory name (no / or \\, not . or .., not an absolute path).');
        console.error(`This command only removes links created by \`link\`, inside ${LAB_EXTENSIONS_DIR}.`);
        process.exitCode = 1;
        return;
    }

    const dest = join(LAB_EXTENSIONS_DIR, name);
    const info = lstatOrNull(dest);
    if (!info) {
        console.error(`Not found: ${dest}`);
        process.exitCode = 1;
        return;
    }
    if (!info.isSymbolicLink()) {
        console.error(`Refusing to delete: ${dest}`);
        console.error(`  It is not a link, it is a real ${info.isDirectory() ? 'directory' : 'file'}.`);
        console.error('  unlink only removes links made by `lab.mjs link`; it will never recursively delete a real');
        console.error('  directory or a copy of your extension source. Delete it yourself if you are sure.');
        process.exitCode = 1;
        return;
    }

    let dangling = false;
    try {
        statSync(dest);   // follows the link; throws when the target is gone
    } catch {
        dangling = true;
    }

    // recursive:true is required to unlink a directory junction, and is safe:
    // removing a link removes the link, it does not walk into the target.
    rmSync(dest, { recursive: true, force: true });
    console.log(`Unlinked: ${dest}${dangling ? ' (was dangling: the target was already gone)' : ''}`);
}

function usage() {
    console.log(USAGE);
}

const USAGE = `sillytavern-lab — run a second, isolated SillyTavern for extension development.

Usage: node lab.mjs <command> [options]

  start                       start in the background; no-op when already running
  run                         run in the foreground, logs in this terminal
  stop                        stop the lab
  restart                     stop, then start
  status                      is it running? exit code 0 = yes, 1 = no
  info                        what the lab would load, and where its data lives
  link <name> <source dir>    expose an extension to the lab only
  unlink <name>               remove that link (never touches your source)
  clean [--dry-run] [--yes]   reclaim test leftovers; dry-run unless --yes
  help                        this text

Everything the lab writes lives in .runtime/ — delete it to start over.
Configuration: lab.config.json (see lab.config.example.json).`;

switch (action) {
    case 'start': await start(); break;
    case 'run': await run(); break;
    case 'stop': await stop(); break;
    case 'restart': await stop(); await start(); break;
    case 'status': await status(); break;
    case 'info': info(); break;
    case 'link': link(rest[0], rest[1]); break;
    case 'unlink': unlink(rest[0]); break;
    case 'clean': clean(rest); break;
    case undefined:
    case 'help':
    case '--help':
    case '-h':
        usage();
        break;
    default:
        console.error(`Unknown command: ${action}`);
        console.error('');
        usage();
        process.exitCode = 1;
}

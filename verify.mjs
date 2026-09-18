/**
 * End-to-end verification — boots SillyTavern against a throwaway data root.
 *
 *     npm run verify
 *
 * `npm test` proves the CLI behaves. This proves the thing the whole tool is
 * for: that a second SillyTavern really does come up on its own port and its own
 * data root, and that tearing it down frees the port again.
 *
 * It never touches the port or data root of your normal lab (or of your real
 * SillyTavern), so it is safe to run while you work. Environment overrides:
 *
 *     LAB_VERIFY_PORT=8012          port for the throwaway instance
 *     LAB_VERIFY_DIR=<path>         where to keep its data root (default .runtime/verify)
 *     LAB_VERIFY_FRESH=1            wipe that data root first (cold webpack build)
 *     LAB_VERIFY_TIMEOUT=<ms>       how long to wait for it to come up
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const LAB_DIR = dirname(fileURLToPath(import.meta.url));
const VERIFY_DIR = process.env.LAB_VERIFY_DIR ?? join(LAB_DIR, '.runtime', 'verify');
const VERIFY_PORT = process.env.LAB_VERIFY_PORT ?? '8012';
const TIMEOUT_MS = Number(process.env.LAB_VERIFY_TIMEOUT ?? 240000);
const FRESH = process.env.LAB_VERIFY_FRESH === '1';

if (FRESH) rmSync(VERIFY_DIR, { recursive: true, force: true });
mkdirSync(VERIFY_DIR, { recursive: true });

// lab-env reads its configuration when it is imported, so the overrides for
// this run have to be in the environment before that import happens. Pointing
// the runtime directory at VERIFY_DIR moves the whole lab state there — data
// root, generated config, log, pid and lock — so this run cannot disturb the
// lab you are using.
process.env.LAB_RUNTIME_DIR = VERIFY_DIR;
process.env.LAB_ST_PORT = VERIFY_PORT;

const env = await import('./lab-env.mjs');

const failures = [];

function check(ok, label, detail = '') {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures.push(label);
}

function tailLog(lines = 25) {
    try {
        const all = readFileSync(env.LOG_PATH, 'utf8').split(/\r?\n/).filter(Boolean);
        return all.slice(-lines).map(l => `    | ${l}`).join('\n');
    } catch {
        return '    | (no log)';
    }
}

function countFiles(dir) {
    try {
        return readdirSync(dir).length;
    } catch {
        return 0;
    }
}

console.log('sillytavern-lab end-to-end verification');
console.log(`  SillyTavern : ${env.stInstall()}`);
console.log(`  data root   : ${env.DATA_ROOT}`);
console.log(`  config      : ${env.CONFIG_PATH}`);
console.log(`  port        : ${env.ST_PORT}`);
console.log(`  log         : ${env.LOG_PATH}`);
console.log('');

const config = env.ensureLabConfig();
if (config.created) console.log(`Created ${config.path} from ${config.base}\n`);

const entry = env.assertServerEntry();
const fd = openSync(env.LOG_PATH, 'w');
const child = spawn(process.execPath, env.serverArgs(), {
    cwd: env.stInstall(),
    env: env.serverEnv(),
    stdio: ['ignore', fd, fd],
    windowsHide: true,
});
closeSync(fd);   // the child owns its copy now

let exited = false;
child.on('exit', () => { exited = true; });

console.log(`Started pid ${child.pid}, waiting up to ${(TIMEOUT_MS / 1000).toFixed(0)}s...`);
const t0 = Date.now();
let up = false;
while (Date.now() - t0 < TIMEOUT_MS) {
    if (await env.isLabUp(2000)) { up = true; break; }
    if (exited) break;
    await new Promise(r => setTimeout(r, 500));
}

console.log('');

if (!up) {
    console.log(`  FAIL  the instance came up on ${env.ST_URL}`);
    console.log(exited ? '  The server process exited early. Last log lines:' : '  Still starting when the timeout hit. Last log lines:');
    console.log(tailLog());
    try { child.kill(); } catch { /* already gone */ }
    console.log(`\n1 check failed. Full log: ${env.LOG_PATH}`);
    process.exit(1);
}

const elapsed = Date.now() - t0;
console.log(`  PASS  it came up on ${env.ST_URL} after ${(elapsed / 1000).toFixed(1)}s`);

let status = 0;
try {
    status = (await fetch(env.ST_URL, { signal: AbortSignal.timeout(5000) })).status;
} catch (error) {
    status = `error: ${error?.message ?? error}`;
}
check(status === 200, 'the lab answers HTTP 200', `got ${status}`);

// The log is the only place that states which data root and config the process
// actually used. Asserting on it is what proves the isolation, rather than
// trusting that the flags were passed.
const log = readFileSync(env.LOG_PATH, 'utf8');
check(
    log.includes(`Using data root: ${env.DATA_ROOT}`),
    'the process used the isolated data root',
    `expected "Using data root: ${env.DATA_ROOT}"`,
);
check(
    log.includes(`Using config path: ${env.CONFIG_PATH}`),
    'the process used the isolated config',
);
check(existsSync(join(env.DATA_ROOT, 'default-user')), 'the data root was populated');
check(countFiles(join(env.DATA_ROOT, '_webpack')) > 0, 'the webpack build went into the isolated data root');

// Tear down, then prove the port came back.
child.kill();
const stopDeadline = Date.now() + 20000;
while (Date.now() < stopDeadline) {
    if (!await env.isLabUp(500)) break;
    await new Promise(r => setTimeout(r, 250));
}
check(!await env.isLabUp(500), `port ${env.ST_PORT} is free again after teardown`);

console.log('');
if (failures.length) {
    console.log(`${failures.length} check(s) failed: ${failures.join('; ')}`);
    console.log(`Full log: ${env.LOG_PATH}`);
    process.exit(1);
}

console.log(`All checks passed. The data root is kept for a warm next run:`);
console.log(`  ${env.DATA_ROOT}   (delete it, or set LAB_VERIFY_FRESH=1, to start cold)`);
console.log(`  entry script used: ${entry}`);

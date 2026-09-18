/**
 * Self-test — no SillyTavern checkout required.
 *
 *     npm test        (or: node --test selftest.mjs)
 *
 * Everything runs against a throwaway lab under .runtime/selftest/: a fake
 * "install" (just a server.js), a synthetic data root full of fixtures, and a
 * JSONC config. Commands are exercised as real subprocesses, so exit codes and
 * output are what a user would actually see.
 *
 * What this does NOT cover: that SillyTavern itself boots against your install.
 * That is `npm run verify`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, openSync, closeSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const LAB_DIR = dirname(fileURLToPath(import.meta.url));
const LAB_MJS = join(LAB_DIR, 'lab.mjs');
const ROOT = join(LAB_DIR, '.runtime', 'selftest');

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });

// ── a fake SillyTavern: lab-env only insists on server.js existing ──
const FAKE_ST = join(ROOT, 'fake-st');
mkdirSync(FAKE_ST, { recursive: true });
writeFileSync(join(FAKE_ST, 'server.js'), '// fake entry point for tests\n');
writeFileSync(join(FAKE_ST, 'config.yaml'), 'port: 8011\n');

// ── a synthetic data root ──
const DATA = join(ROOT, 'data');
const USER = join(DATA, 'default-user');

function fixture(relPath, contents = 'fixture') {
    const full = join(USER, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
    return full;
}

const DELETE_ME = [
    fixture(join('characters', 'MyExt-Test-1.png')),
    fixture(join('characters', 'MyExt-Test-2.png')),
    fixture(join('thumbnails', 'avatar', 'MyExt-Test-1.png')),
    fixture(join('worlds', 'MyExt-Test-book.json')),
    fixture(join('worlds', 'MyExt-Test-book (1).json')),
    fixture(join('backups', 'chat____1730000000000.jsonl')),
];

const KEEP_ME = [
    fixture(join('characters', 'keep-me.png')),                       // no pattern match
    fixture(join('characters', 'default_Seraphina.png')),             // built-in protection
    fixture(join('characters', 'Seraphina', 'MyExt-Test-sprite.png')),// nested one level down: clean must not recurse
    fixture(join('worlds', 'MyExt-Test-protected.json')),             // matches, but protected by config
    fixture(join('worlds', 'Eldoria.json')),                          // built-in protection
    fixture(join('settings.json'), '{}'),                             // built-in protection
];

// A directory whose name matches a rule must survive: clean only deletes files.
const MATCHING_DIR = join(USER, 'characters', 'MyExt-Test-looks-like-a-card.png');
mkdirSync(MATCHING_DIR, { recursive: true });
writeFileSync(join(MATCHING_DIR, 'inner.txt'), 'must survive');

// ── config: JSONC, with a trailing comma and a `//` inside a string value ──
const ST_PORT = 18011;
const CONFIG = join(ROOT, 'lab.config.json');
writeFileSync(CONFIG, `{
  // Comments and trailing commas are allowed.
  "stInstall": ${JSON.stringify(FAKE_ST.replace(/\\/g, '/'))},
  "dataRoot": ${JSON.stringify(DATA.replace(/\\/g, '/'))},
  "configPath": "./generated-config.yaml",
  "ports": { "st": ${ST_PORT}, "mock": 18123, "cdp": 19333, },
  "residue": {
    "rules": [
      { "dir": "characters", "pattern": "^MyExt-Test-.*\\\\.png$", "reason": "test card; see http://example.com/docs for why" },
      { "dir": "thumbnails/avatar", "pattern": "^MyExt-Test-.*\\\\.png$", "reason": "thumbnail of the same card" },
      { "dir": "worlds", "pattern": "^MyExt-Test-.*\\\\.json$", "reason": "lorebook fixture" },
      { "dir": "backups", "pattern": "^chat____.*\\\\.jsonl$", "reason": "chat backup from a nameless test chat" },
    ],
    "protect": [
      { "path": "worlds/MyExt-Test-protected.json", "note": "hand-written, keep" },
    ],
  },
}
`);

const GENERATED_CONFIG = join(ROOT, 'generated-config.yaml');

let seq = 0;

/**
 * Run the CLI in a subprocess.
 *
 * stdout/stderr go to files rather than pipes: a piped child needs the parent
 * to keep draining it, and in restricted environments creating the pipe itself
 * is what fails.
 */
function runCli(args, extraEnv = {}) {
    const id = ++seq;
    const outFile = join(ROOT, `out-${id}.txt`);
    const errFile = join(ROOT, `err-${id}.txt`);
    const fdOut = openSync(outFile, 'w');
    const fdErr = openSync(errFile, 'w');

    let result;
    try {
        result = spawnSync(process.execPath, [LAB_MJS, ...args], {
            env: {
                ...process.env,
                LAB_CONFIG_FILE: CONFIG,
                LAB_ST_INSTALL: FAKE_ST,
                LAB_RUNTIME_DIR: join(ROOT, 'runtime'),
                LAB_DATA_ROOT: DATA,
                LAB_CONFIG_PATH: GENERATED_CONFIG,
                LAB_ST_PORT: String(ST_PORT),
                LAB_MOCK_PORT: '18123',
                LAB_CDP_PORT: '19333',
                ...extraEnv,
            },
            stdio: ['ignore', fdOut, fdErr],
            windowsHide: true,
        });
    } finally {
        closeSync(fdOut);
        closeSync(fdErr);
    }

    return {
        status: result.status,
        error: result.error,
        stdout: readFileSync(outFile, 'utf8'),
        stderr: readFileSync(errFile, 'utf8'),
    };
}

/** Guard against a silently broken harness: an empty result must not read as success. */
function expectRan(result) {
    assert.equal(result.error, undefined, `subprocess failed to start: ${result.error?.message ?? result.error}`);
    assert.notEqual(result.status, null, 'subprocess produced no exit code');
}

// ───────────────────────────────── CLI surface ─────────────────────────────────

test('help exits 0 and lists the commands', () => {
    const r = runCli(['help']);
    expectRan(r);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Usage: node lab\.mjs/);
    assert.match(r.stdout, /clean \[--dry-run\] \[--yes\]/);
});

test('no arguments prints usage and exits 0', () => {
    const r = runCli([]);
    expectRan(r);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Usage:/);
});

test('an unknown command exits 1 and still prints usage', () => {
    const r = runCli(['frobnicate']);
    expectRan(r);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Unknown command: frobnicate/);
    assert.match(r.stdout, /Usage:/);
});

test('status exits 1 when nothing is listening', () => {
    const r = runCli(['status']);
    expectRan(r);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /not running/);
});

test('status reports the configured data root', () => {
    const r = runCli(['status']);
    expectRan(r);
    assert.ok(r.stdout.includes(DATA), `expected the data root in:\n${r.stdout}`);
});

// ───────────────────────────────── config parsing ─────────────────────────────────

test('lab.config.json is parsed as JSONC, including "//" inside a string', () => {
    const r = runCli(['clean']);
    expectRan(r);
    assert.equal(r.status, 0);
    // The rule's reason text survives the comment stripper intact.
    assert.match(r.stdout, /http:\/\/example\.com\/docs/);
});

test('clean rejects unknown arguments', () => {
    const r = runCli(['clean', '--force']);
    expectRan(r);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Unknown argument\(s\): --force/);
});

// ───────────────────────────────── clean ─────────────────────────────────

test('clean is a dry run by default and deletes nothing', () => {
    const r = runCli(['clean']);
    expectRan(r);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /dry run: nothing will be touched/);
    for (const f of DELETE_ME) {
        assert.ok(existsSync(f), `dry run deleted ${f}`);
    }
});

test('clean lists every matching file and skips the protected ones', () => {
    const r = runCli(['clean']);
    expectRan(r);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Would delete \(6 items/);

    // Compare against the deletion list only; the protected list further down is
    // supposed to mention the protected paths.
    const deletionList = r.stdout.split('Total:')[0];
    for (const f of KEEP_ME) {
        const name = f.split(/[\\/]/).pop();
        assert.ok(!deletionList.includes(name), `protected file was listed for deletion: ${name}`);
    }
    assert.ok(!deletionList.includes('MyExt-Test-looks-like-a-card.png'), 'a matching directory was listed for deletion');

    // Config-driven protection reports itself rather than failing silently.
    assert.match(r.stdout, /MyExt-Test-protected\.json matched a pattern but is protected/);

    // clean never recurses, so a matching name one level down is out of reach —
    // it must not appear anywhere, not even as a skipped entry.
    assert.ok(!r.stdout.includes('MyExt-Test-sprite.png'), 'clean looked inside a subdirectory');
});

test('--dry-run beats --yes', () => {
    const r = runCli(['clean', '--dry-run', '--yes']);
    expectRan(r);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /treating this as a dry run/);
    for (const f of DELETE_ME) {
        assert.ok(existsSync(f), `--dry-run --yes deleted ${f}`);
    }
});

test('clean --yes deletes exactly the matching files', () => {
    const r = runCli(['clean', '--yes']);
    expectRan(r);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Deleted 6 items/);

    for (const f of DELETE_ME) {
        assert.ok(!existsSync(f), `should have been deleted: ${f}`);
    }
    for (const f of KEEP_ME) {
        assert.ok(existsSync(f), `should have been kept: ${f}`);
    }
    assert.ok(existsSync(MATCHING_DIR), 'a directory that matches a rule must never be deleted');
    assert.ok(existsSync(join(MATCHING_DIR, 'inner.txt')), 'contents of a matching directory must never be deleted');
});

test('clean is idempotent', () => {
    const r = runCli(['clean', '--yes']);
    expectRan(r);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Nothing matched/);
});

// ───────────────────────────────── link / unlink ─────────────────────────────────

test('link rejects a name that could escape the extensions directory', () => {
    for (const bad of ['..', '.', 'a/b', 'a\\b', '']) {
        const r = runCli(['link', bad, FAKE_ST]);
        expectRan(r);
        assert.equal(r.status, 1, `expected ${JSON.stringify(bad)} to be rejected`);
    }
});

test('link rejects a source that is not a directory', () => {
    const r = runCli(['link', 'SillyTavern-MyExt', join(FAKE_ST, 'server.js')]);
    expectRan(r);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not a directory/);
});

test('link and unlink round-trip without touching the source', () => {
    const src = join(ROOT, 'MyExt-Plugin', 'SillyTavern-MyExt');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'manifest.json'), '{}');

    const linked = runCli(['link', 'SillyTavern-MyExt', src]);
    expectRan(linked);
    assert.equal(linked.status, 0, linked.stderr);

    const dest = join(USER, 'extensions', 'SillyTavern-MyExt');
    assert.ok(existsSync(dest), 'link did not create the extension');
    assert.ok(existsSync(join(dest, 'manifest.json')), 'link is not transparent');

    const info = runCli(['info']);
    expectRan(info);
    assert.match(info.stdout, /Lab-only extensions/);
    assert.ok(info.stdout.includes('SillyTavern-MyExt'));

    // Refuses to overwrite an existing mount.
    const again = runCli(['link', 'SillyTavern-MyExt', src]);
    expectRan(again);
    assert.equal(again.status, 1);

    const unlinked = runCli(['unlink', 'SillyTavern-MyExt']);
    expectRan(unlinked);
    assert.equal(unlinked.status, 0, unlinked.stderr);
    assert.ok(!existsSync(dest), 'unlink left the link behind');
    assert.ok(existsSync(join(src, 'manifest.json')), 'unlink damaged the extension source');
});

test('unlink refuses to delete a real directory', () => {
    const dest = join(USER, 'extensions', 'SillyTavern-RealOne');
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'manifest.json'), '{}');

    const r = runCli(['unlink', 'SillyTavern-RealOne']);
    expectRan(r);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Refusing to delete/);
    assert.ok(existsSync(join(dest, 'manifest.json')), 'unlink deleted a real directory');
});

// ───────────────────────────────── lock ─────────────────────────────────
// These import lab-env.mjs directly, so they must set the environment before
// that import happens — lab-env reads its configuration at module load.

test('the lock is global, and a lock owned by a dead process is taken over', async () => {
    process.env.LAB_CONFIG_FILE = CONFIG;
    process.env.LAB_ST_INSTALL = FAKE_ST;
    process.env.LAB_RUNTIME_DIR = join(ROOT, 'runtime');
    process.env.LAB_DATA_ROOT = DATA;
    process.env.LAB_CONFIG_PATH = GENERATED_CONFIG;
    process.env.LAB_CDP_PORT = '19333';

    const env = await import('./lab-env.mjs');

    assert.equal(env.ST_PORT, ST_PORT, 'ports.st from lab.config.json was not applied');
    assert.equal(env.cdpPort(0), 19333);
    assert.equal(env.cdpPort(2), 19335);

    rmSync(env.LOCK_PATH, { force: true });

    // A lock whose owner is dead must not wedge the lab.
    mkdirSync(dirname(env.LOCK_PATH), { recursive: true });
    writeFileSync(env.LOCK_PATH, JSON.stringify({ name: 'killed-run', pid: 2147483647, at: '2026-01-01T00:00:00.000Z' }));
    env.acquireLock('selftest');
    assert.ok(existsSync(env.LOCK_PATH));

    // Held by us, but a *different name* is still refused: exclusion is per lab,
    // not per name. This is the property the whole design rests on.
    assert.throws(() => env.acquireLock('some-other-script'), /The lab is busy/);

    env.releaseLock();
    assert.ok(!existsSync(env.LOCK_PATH), 'releaseLock left the lock behind');
});

test('lab-env reports the three isolation layers as distinct paths', async () => {
    const env = await import('./lab-env.mjs');
    assert.equal(env.DATA_ROOT, DATA);
    assert.notEqual(env.LAB_EXTENSIONS_DIR, env.globalExtensionsDir());
    assert.ok(env.LAB_EXTENSIONS_DIR.startsWith(DATA), 'lab extensions must live inside the lab data root');
    assert.ok(env.globalExtensionsDir().startsWith(env.stInstall()), 'global extensions must live inside the install');
    assert.equal(env.USER_DIR, USER);
});

test('the generated config is copied from SillyTavern, not invented', async () => {
    const env = await import('./lab-env.mjs');
    rmSync(GENERATED_CONFIG, { force: true });

    const first = env.ensureLabConfig();
    assert.equal(first.created, true);
    assert.equal(first.base, join(FAKE_ST, 'config.yaml'));
    assert.equal(readFileSync(GENERATED_CONFIG, 'utf8'), readFileSync(join(FAKE_ST, 'config.yaml'), 'utf8'));

    // An existing config is never overwritten: your edits must survive.
    writeFileSync(GENERATED_CONFIG, 'port: 9999\n');
    const second = env.ensureLabConfig();
    assert.equal(second.created, false);
    assert.equal(readFileSync(GENERATED_CONFIG, 'utf8'), 'port: 9999\n');
});

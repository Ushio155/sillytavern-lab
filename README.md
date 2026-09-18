# sillytavern-lab

[![selftest](https://github.com/Ushio155/sillytavern-lab/actions/workflows/selftest.yml/badge.svg)](https://github.com/Ushio155/sillytavern-lab/actions/workflows/selftest.yml)

Run a **second, isolated SillyTavern** so you can develop and test extensions
without touching your real chats, characters, lorebooks or settings.

- Your real SillyTavern keeps running on its normal port, with your real data.
- The lab runs on another port, from its own data root. Test cards, test
  lorebooks and destructive experiments all land there.
- The lab sees a **lab-only copy** of the extension you are working on, which
  *shadows* the installed one. Your half-finished build cannot break the copy
  you actually chat with.
- One shared lock serialises test scripts, so two of them can never quietly
  corrupt each other's fixtures.

No dependencies. No changes to your SillyTavern checkout.

```
Lab  ── port 8011 ── .runtime/data/        ── lab-only extensions/
Real ── port 8000 ── <your real data>/     ── globally installed extensions/
        (same install directory, same public/ code, different everything else)
```

---

## Why this exists

SillyTavern is a good citizen here: `--port`, `--dataRoot` and `--configPath`
already let you start a second instance. If that is all you need, do that — you
do not need this project.

The trouble starts once you are developing several extensions and each one has
test scripts:

| What goes wrong | What the lab does about it |
|---|---|
| Testing creates characters, lorebooks and chats that pile up in your real data, and you cannot tell fixture files from real ones later | Everything lands in the lab data root; `clean` reclaims leftovers by the name patterns *you* declare |
| You cannot test "delete every character" — or anything else destructive — safely | The lab data root is disposable; delete it and it is rebuilt on next start |
| Your broken work-in-progress has to be installed for the real client, so you cannot use SillyTavern while you develop | `link` mounts it lab-only; a lab copy shadows the global one of the same name |
| Two test scripts running at once overwrite each other's `settings.json` and delete each other's fixtures, and the symptom is a flaky assertion in whichever script loses | One global lock; a lock left behind by a killed run is taken over automatically |
| Every script hardcodes its own URL, port and paths | `lab-env.mjs` is the single source of truth every script imports |
| A second copy of your extension silently drifts a few commits behind while both `manifest.json` files claim the same version | `link` is a symlink: there is only ever one copy of the code |

That last row is not hypothetical. It is why this tool exists: a real
SillyTavern install was running a four-day-old clone of an extension whose
version string matched the current source exactly, so nothing looked wrong.

---

## Requirements

- Node.js 20 or newer
- A working SillyTavern checkout (`npm install` already done)

## Quick start

```bash
git clone https://github.com/Ushio155/sillytavern-lab.git
cd sillytavern-lab

# Point it at your install (or let it auto-detect a conventional location)
cp lab.config.example.json lab.config.json
#   ... then edit "stInstall"
```

```bash
node lab.mjs start          # boots the lab, waits until it answers
```

Open <http://127.0.0.1:8011/> — that is the lab. Your real SillyTavern is still
on 8000, untouched.

```bash
node lab.mjs link SillyTavern-MyExtension /path/to/MyExtension-Plugin/SillyTavern-MyExtension
node lab.mjs start --restart   # not a real flag: use `node lab.mjs restart`
```

Now the lab loads your working copy. Reload the lab page and it is there; your
real SillyTavern never sees it.

```bash
node lab.mjs status     # running? exit code 0 = yes, 1 = no
node lab.mjs info       # what the lab loads, and where its data is
node lab.mjs stop
```

## The three layers

| Layer | Path | Shared with your real instance? |
|---|---|---|
| Install directory | `<stInstall>/public/` | **Yes** — same files, same version. No second download, no drift. |
| Data root | `.runtime/data/` | **No** — chats, characters, worlds, `settings.json`, `_webpack` are all private. |
| Extensions | `.runtime/data/default-user/extensions/` | **No** — and a folder here *shadows* a globally installed extension of the same name. |

Everything the lab writes lives under `.runtime/`. Delete that directory and the
lab is factory-fresh; nothing else on your machine was changed.

The lab's `config.yaml` is **copied from your own SillyTavern config** on first
start, rather than being a hand-written template that rots the next time
upstream adds a setting. It is never overwritten afterwards, so your edits
survive.

---

## Configuration

Copy `lab.config.example.json` to `lab.config.json`. It is JSONC — comments and
trailing commas are fine.

| Key | Default | Meaning |
|---|---|---|
| `stInstall` | auto-detected | Your SillyTavern checkout (the directory with `server.js` in it) |
| `dataRoot` | `.runtime/data` | Lab-private data root; relative paths resolve against this directory |
| `configPath` | `.runtime/config.yaml` | The `config.yaml` handed to the lab |
| `configBase` | your `config.yaml` | Template to copy the lab config from on first start |
| `listen` | `false` | Accept connections from outside this machine |
| `browserLaunch` | `false` | Pop open a browser window on start |
| `overrides` | see example | Extra `config.yaml` settings as dotted keys |
| `ports.st` / `.mock` / `.cdp` | `8011` / `8123` / `9333` | Lab, mock API server, browser debugging |
| `runtimeDir` | `.runtime` | Where runtime state lives: log, pid, lock, generated config, data root |
| `residue` | `{}` | What `clean` may delete — see below |

`overrides` are handed to the lab process as SillyTavern's documented
`SILLYTAVERN_*` environment variables, so **no YAML is ever rewritten**. The
default disables the on-disk character cache, whose entries SillyTavern never
reclaims.

Environment variables override the file: `LAB_ST_INSTALL`, `LAB_DATA_ROOT`,
`LAB_CONFIG_PATH`, `LAB_CONFIG_FILE`, `LAB_RUNTIME_DIR`, `LAB_ST_PORT`,
`LAB_MOCK_PORT`, `LAB_CDP_PORT`, `LAB_ST_URL`.

`listen` defaults to `false` deliberately. An isolated test instance that
silently becomes reachable from your network is a nasty surprise.

---

## Reclaiming test leftovers

`clean` deletes **only** regular files whose name matches a pattern you wrote,
and only outside its protected list. It never recurses, never follows a symlink,
and never guesses that something "looks like junk".

Declare what your tests create:

```jsonc
"residue": {
  "rules": [
    { "dir": "characters",        "pattern": "^MyExt-Test-.*\\.png$",  "reason": "one fresh test card per run" },
    { "dir": "thumbnails/avatar", "pattern": "^MyExt-Test-.*\\.png$",  "reason": "the thumbnail of that same card" },
    { "dir": "worlds",            "pattern": "^MyExt-Test-.*\\.json$", "reason": "lorebook fixtures" }
  ],
  "protect": [
    { "path": "worlds/MyHandWrittenBook.json", "note": "written by hand, not a fixture" }
  ]
}
```

```bash
node lab.mjs clean            # dry run: lists what it would delete, touches nothing
node lab.mjs clean --yes      # actually deletes
```

`--dry-run` beats `--yes` if both are given: a flag named dry-run that can still
delete is worse than no flag at all. SillyTavern's own bundled sample character
and lorebook are protected by default, as is your `settings.json`.

There is also a built-in sweep for stale entries in `_cache/characters` — cache
files whose target character no longer exists.

---

## Using the lab from your test scripts

`lab-env.mjs` is the shared contract. Import it instead of hardcoding anything:

```js
import { ST_URL, MOCK_PORT, assertLabUp, withHarnessLock, cdpPort } from '../lab/lab-env.mjs';

await assertLabUp();                    // throws with a fix-it message if the lab is down

await withHarnessLock('myext-driver', async () => {
    // Only one script holds this at a time. A lock left behind by a killed run
    // is detected (dead pid) and taken over, so a Ctrl-C never wedges the lab.
    await fetch(`${ST_URL}api/characters/all`);
});

// Browser automation: ask for a slot instead of hardcoding 9333 + n
const port = cdpPort(1);
```

The lock is deliberately **global, not per name**: two scripts must never share
one data root, so `withHarnessLock('a')` and `withHarnessLock('b')` exclude each
other too.

Exported: `ST_URL`, `ST_PORT`, `MOCK_URL`, `MOCK_PORT`, `CDP_PORT`, `cdpPort(slot)`,
`LAB_DIR`, `ST_INSTALL` (`stInstall()`), `DATA_ROOT`, `CONFIG_PATH`,
`USER_DIR`, `WORLDS_DIR`, `LAB_EXTENSIONS_DIR`, `globalExtensionsDir()`,
`isLabUp`, `waitForLabUp`, `assertLabUp`, `withHarnessLock`, `acquireLock`,
`releaseLock`, `readLock`, `isAlive`, `ensureLabConfig`, `RESIDUE`.

---

## Commands

| Command | What it does |
|---|---|
| `node lab.mjs start` | Start detached. No-op when already running. Waits until the lab answers. |
| `node lab.mjs run` | Run in the foreground with logs in this terminal. Use this in CI, in an agent sandbox, or anywhere detached children get reaped. |
| `node lab.mjs stop` | Stop it. Refuses to kill a process it did not start. |
| `node lab.mjs restart` | Stop, then start. |
| `node lab.mjs status` | Running? Exit code 0 = yes, 1 = no. |
| `node lab.mjs info` | Which extensions the lab would load, and where its data is. |
| `node lab.mjs link <name> <dir>` | Mount an extension lab-only. |
| `node lab.mjs unlink <name>` | Remove that mount. Never touches your source. |
| `node lab.mjs clean [--dry-run] [--yes]` | Reclaim test leftovers. Dry run by default. |

`link` and `unlink` only ever touch symlinks they created. `unlink` refuses to
delete a real directory, and a name containing `/`, `\` or `..` is rejected
outright — otherwise `unlink ..` would happily delete something well outside the
extensions folder.

---

## Tests

```bash
npm test          # 19 checks, no SillyTavern install needed
npm run verify    # boots a real instance on port 8012 and asserts it is isolated
```

`npm test` exercises the CLI end to end against a throwaway lab: JSONC parsing,
the dry-run/`--yes` contract, protected files, non-recursion, `link`/`unlink`
safety, and the lock's stale-owner takeover.

`npm run verify` is the one that proves the actual promise. It starts
SillyTavern on a throwaway port and data root, asserts HTTP 200, then reads the
server log to confirm the process really used *that* data root and config — and
finally that stopping it frees the port. It is safe to run while your own lab or
your real SillyTavern is up, because it uses neither's data root.

## What has and has not been verified

Written to be honest about this, because a test-isolation tool that quietly does
not isolate is worse than none.

**Verified:**

- `npm test`: 19/19.
- `npm run verify`: a real SillyTavern 1.18.0 instance booting on Windows with an
  isolated port, data root and config; port released on teardown.
- The shadowing behaviour (a lab-only extension hiding a globally installed one
  of the same name) — observed on 1.18.0.
- Real extension test suites run against a lab built this way: 25 and 119
  assertions, both green, with the real install's data untouched.

**Not verified:**

- Anything other than Windows and Node 22. The POSIX process-lookup path is
  best-effort only, and only affects *diagnostic messages* — the lab's own
  liveness check is an HTTP request and is platform-independent.
- The `performance.useDiskCache` override. It is passed via SillyTavern's
  documented `SILLYTAVERN_*` environment mechanism, which is not exercised by
  the tests; if it were ignored, the only consequence is a growing `_cache`
  directory.
- SillyTavern versions other than 1.18.0.

## Caveats

- One data root serves one lab process at a time. That is the point, but it means
  the lock is real: scripts that do not take it can still collide.
- `link` creates a directory symlink (a junction on Windows). On Windows a
  junction to a network path or another drive may fail; keep sources local.
- The lab shares `public/` with your real instance, so a broken *SillyTavern*
  checkout breaks both. Extension code is isolated; the server is not.
- The extension-shadowing rule is SillyTavern behaviour this project relies on
  and does not control. If upstream changes it, `link` stops hiding your
  work-in-progress from the real client. `node lab.mjs info` showing your
  extension under "Lab-only extensions" is the check that it still works.

## License

MIT

# Client dependencies

**Updated:** 2026-10-10 · vetting record for `client/` (M3, T0). Everything below was read from `client/package-lock.json` and the npm registry on that date; the coordinator re-verifies it at G0. Nothing in the root or `bridge/` has dependencies.

## How these were resolved
- `npm --prefix client install --before=2026-09-25 --save-exact preact`, then the same flags with `--save-dev` for the toolchain, naming `@playwright/test@1.63.0` and `@types/node@22` (the line that matches the Node 22 runtime). Node 22.16.0, npm 10.9.2. The cutoff is two weeks before 2026-10-09, and `--before` applies to transitive packages too.
- `client/.npmrc` sets `ignore-scripts=true` (no install-time code runs; the toolchain works without it, see below) and `save-exact=true`.
- Checked afterwards, not assumed: all 209 distinct `name@version` pairs in the lockfile have a registry publish time before 2026-09-25T00:00:00Z. The newest is `electron-to-chromium@1.5.439` at 2026-09-24T22:04:51Z. Every `resolved` URL is on `https://registry.npmjs.org/`, every entry has an `integrity` hash, and there are no git, file or link specs.

## Direct dependencies
All twelve are exact versions in `client/package.json` and match the lockfile. "Age" is days before 2026-10-09, the date the cutoff was set from; the policy is at least 14. No package declares a `preinstall`, `install` or `postinstall` script (`npm view <pkg>@<ver> scripts`), and none carries `hasInstallScript` in the lockfile.

| Package | Version | Published (UTC) | Age | Kind | Purpose |
|---|---|---|---|---|---|
| `preact` | 10.29.8 | 2026-08-01 | 69 | runtime | UI runtime; the only code that ships in `dist` |
| `vite` | 8.3.1 | 2026-09-24 | 15 | dev | dev server and production bundler (Rolldown-based in v8) |
| `@preact/preset-vite` | 2.10.6 | 2026-07-18 | 83 | dev | Vite plugin: Preact JSX transform and dev hot reload |
| `typescript` | 7.0.2 | 2026-07-08 | 93 | dev | type checker (`tsc --noEmit`); v7 is the native compiler |
| `vitest` | 5.0.1 | 2026-09-15 | 24 | dev | unit-test runner |
| `jsdom` | 29.1.1 | 2026-04-30 | 162 | dev | DOM for unit tests |
| `@testing-library/dom` | 10.4.2 | 2026-09-13 | 26 | dev | role and accessible-name queries in unit tests |
| `@testing-library/user-event` | 14.6.7 | 2026-09-02 | 37 | dev | keyboard and pointer simulation in unit tests |
| `axe-core` | 4.13.0 | 2026-08-05 | 65 | dev | accessibility rules in jsdom unit tests; the same copy `@axe-core/playwright` uses (deduped) |
| `@playwright/test` | 1.63.0 | 2026-09-04 | 35 | dev | end-to-end runner, pinned to the release whose Chromium build is already cached |
| `@axe-core/playwright` | 4.13.0 | 2026-08-11 | 59 | dev | axe inside end-to-end runs |
| `@types/node` | 22.20.4 | 2026-09-19 | 20 | dev | Node typings for the Playwright config, scripts and tests |

Not added, as the plan says: a router, a state library, ESLint, `idb` (M4), `@testing-library/preact`.

## Lockfile
- `lockfileVersion` 3; 210 entries excluding the root project (1 runtime, 162 dev, 47 dev and optional). `npm ci` on this host (linux-x64) installs 168 of them; the rest are platform binaries for other systems.
- The 47 optional entries are native binaries in four families: 15 `@rolldown/binding-*`, 20 `@typescript/typescript-*`, 11 `lightningcss-*` and `fsevents`. On Linux both the glibc and musl variants install.
- **Entries with `hasInstallScript`: one.** `fsevents@2.3.3`, dev and optional, `os: darwin`, requested by `vite@8.3.1`. It is not installed on Linux and would not run anyway because of `ignore-scripts=true`.
- With `ignore-scripts=true` the whole toolchain works on Linux: `npm ci`, typecheck, unit tests, build and a headless Chromium launch all passed. No package needs a script.

## Playwright pin
- `@playwright/test` 1.63.0, published 2026-09-04: the newest stable release at or before the cutoff. 1.64.0 (2026-10-07) is after it.
- `playwright-core@1.63.0` `browsers.json` (read from the registry tarball): `chromium` 1243 (153.0.8010.12), `chromium-headless-shell` 1243, `ffmpeg` 1011.
- `~/.cache/ms-playwright` already holds `chromium-1243`, `chromium_headless_shell-1243` and `ffmpeg-1011`, each with `INSTALLATION_COMPLETE`. `chromium.executablePath()` resolves to `~/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`, which exists and is executable.
- One headless launch of Chromium 153.0.8010.12 through Playwright rendered a page and closed cleanly. Nothing was downloaded; `playwright install` was not run, not even with `--dry-run`.
- Fallback: 1.62.1 (2026-07-30) needs Chromium 1234, also cached. Its `browsers.json` was read; it was not launched.

## npm audit (2026-10-10)
- Whole tree: **1 high**, 0 critical, 0 moderate, 0 low. Runtime dependencies only (`npm --prefix client audit --omit=dev`): **0**.
- `source-map-js` 1.2.1 (GHSA-68fv-2mgg-jv7q, high, CVSS 7.5, CWE-1284): event-loop denial of service through indexed source-map section offsets. Affected range `>=1.0.0 <1.2.2`. It arrives through `css-tree@3.2.1` (from `jsdom`) and `postcss@8.5.28` (from `vite`).
- The fix, `source-map-js@1.2.2`, was published 2026-09-30, five days after the cutoff, so `--before` correctly excluded it. It will be 14 days old on 2026-10-14.
- Assessment (inferred, not tested): exposure is build and test time only. The package is not in `dist` (a search of `client/dist` for it and for `sourceMappingURL` finds nothing), `build.sourcemap` is `false`, and no step feeds these tools a source map from outside the repository.
- Left unresolved on purpose: adding an `overrides` entry for `source-map-js` or moving the cutoff is a dependency change, which is the coordinator's call. If wanted, wait until 2026-10-14, add `"overrides": { "source-map-js": "1.2.2" }` to `client/package.json`, regenerate the lockfile and rerun this record.

## Observations
- **Node floor.** The plan said `engines.node >=22.5`, but the toolchain needs more: `jsdom@29.1.1` requires `^22.13.0`, `vitest@5.0.1` `^22.12.0`, `vite@8.3.1` `^22.12.0` (the coordinator confirmed this from the lockfile at G0). `client/package.json` therefore says `>=22.13`: building or testing the client needs Node 22.13 or later; the bridge alone still needs 22.5. This host runs 22.16.0.
- **New majors.** TypeScript 7.0.2, Vite 8.3.1, Vitest 5.0.1 and jsdom 29.1.1 are recent majors. Everything in T0 ran on them. I did not test older lines (Vite 7, Vitest 4, TypeScript 6), so they are untried fallbacks if a later task hits a toolchain bug.
- **TypeScript 7.** `tsconfig.json` sets `types` explicitly and avoids options TypeScript 7 removed (`baseUrl`, `node10` resolution, `esModuleInterop: false` and others).

## Licences (D9, confirmed 2026-10-13)
The project is MIT (`LICENSE`, "Copyright (c) 2026 Cyan Society"; `package.json` files and the README say MIT). Every package that ends up in the shipped bundle is MIT (`preact`). The non-MIT packages are dev-only and are not shipped: `axe-core` and `@axe-core/playwright` (MPL-2.0) and `@playwright/test` (Apache-2.0). Check this again when a dependency is added: `idb`'s licence is part of vetting it in M4.

## Re-checking this record
```sh
npm --prefix client ci
npm --prefix client audit            # whole tree
npm --prefix client audit --omit=dev # runtime only
npm view <pkg>@<version> time --json # publish time of a direct dependency
node -e 'const l=require("./client/package-lock.json");for(const [k,v] of Object.entries(l.packages))if(v.hasInstallScript)console.log(k,v.version,"os="+JSON.stringify(v.os))'
```

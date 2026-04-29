# Baseline Runner

Browser-side test harness that captures **ground-truth output** from a real
SillyTavern install. Produces baseline JSON files that the miniAPP migrated
prompt engine must reproduce byte-for-byte.

## Files

```
packages/backend/test/baseline-runner/
├── README.md                ← you are here
├── harness.js               ← shared utilities (mocks, fixture loader, JSON download)
└── adapters/
    └── macros.js            ← Step 0 adapter (substituteParams)
                                Future: instruct.js, world-info.js, ...
```

These files are **canonical here** in the miniAPP repo. The sync script at
`packages/backend/scripts/sync-baseline-runner.mjs` copies them — together
with the case fixtures in `packages/backend/test/fixtures/<step>/cases/` —
into a running SillyTavern install at `<runtime>/public/baseline-runner/`.

## Prerequisites

1. A working SillyTavern install. Default expected at `~/python_project/SillyTavern_runtime`.
   Override via `ST_RUNTIME_PATH` env var.
2. ST has been booted at least once (`npm install && npm start`) so that
   `data/_webpack/.../output/lib.js` exists. The browser's `/lib.js` URL
   serves that bundled file.

## Workflow (Step 0 baseline capture)

```bash
# 1. Sync runner code + case fixtures into the running ST install.
cd ST_miniAPP/packages/backend
node scripts/sync-baseline-runner.mjs                # all steps
node scripts/sync-baseline-runner.mjs --step macros  # one step only

# 2. Start ST (in another terminal).
cd /Users/qj/python_project/SillyTavern_runtime
npm install   # only first time
npm start     # serves at http://localhost:8000

# 3. Open http://localhost:8000 in a browser. Wait for the home screen / any
#    chat to load (this ensures ST's ESM modules are instantiated).

# 4. Open devtools console and paste:
import('/baseline-runner/adapters/macros.js').then(m => m.run())

# 5. The browser will download:
#    sillytavern-original-macros-YYYYMMDD-HHmm.json

# 6. Move the downloaded file into:
#    ST_miniAPP/packages/backend/test/fixtures/macros/baselines/
```

## What the runner actually does (Step 0)

For every case in `fixtures/macros/cases/index.json`:

1. Backs up `chat`, `chat_metadata`, `characters`, `this_chid`, and
   `power_user.persona_description` / `experimental_macro_engine`.
2. Pushes a synthetic character into `characters[]` matching the case's
   `character` bucket; points `this_chid` at it via `setCharacterId()`.
3. Replaces `chat[]` and `chat_metadata` in place with case data.
4. Sets `power_user.persona_description = case.character.persona ||
case.user.personaDescription`.
5. Wraps the call site so:
   - `Math.random` is overridden by `seedrandom(case.options.seed, { global: true })`
   - `moment.now` is overridden to return `Date.parse(case.options.now)`
   - `moment.locale('en')` for stable `{{date}}/{{weekday}}`
6. Calls `MacroEnvBuilder.buildFromRawEnv(ctx)` then `MacroEngine.evaluate(template, env)`
   directly. This is exactly the path that `substituteParams()` takes when
   the experimental flag is on — calling them directly lets us snapshot
   `MacroEnv` for diff localization.
7. Captures `console.warn / console.error` during the call to collect
   `MacroDiagnostics` warnings.
8. Restores everything in `finally` blocks (per-case partial restore +
   once-at-end full restore).

## Adding a new step (e.g. instruct, world-info)

1. Create `packages/backend/test/fixtures/<stepName>/cases/index.json` and
   `cases/*.json` following the schema in
   `packages/backend/test/fixtures/macros/schema/case.schema.json` (or define
   a new schema if the inputs are structurally different).
2. Create `packages/backend/test/baseline-runner/adapters/<stepName>.js`. Copy
   `adapters/macros.js` as a starting point. The harness gives you
   `runStep / withDeterministicEnv / captureConsole / snapshotJsonSafe`.
3. Sync. Open ST. Paste:
   ```js
   import('/baseline-runner/adapters/<stepName>.js').then((m) => m.run());
   ```
4. Add `<stepName>/baselines/` under fixtures and drop the downloaded JSON.

## Troubleshooting

- **`Failed to load case index at /baseline-runner/fixtures/macros/cases/index.json`**
  → You forgot to run sync, or `ST_RUNTIME_PATH` points to the wrong place.
- **`Failed to resolve module specifier 'lodash'`** in console
  → ST's webpack hasn't built `lib.js` yet. Make sure you ran `npm start`
  at least once (or `npm install` for the postinstall path).
- **Output looks wrong but no error**
  → Check `window.__lastBaselinePayload` for `meta.warnings` and
  `meta.envSnapshot`. Most issues are visible there.
- **Random / time results differ between captures**
  → Ensure `case.options.seed` and `case.options.now` are set. The harness
  can only mock determinism if the case asks for it.

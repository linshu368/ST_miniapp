# Macro Engine Fixtures (Step 0 baseline)

This directory hosts the **frozen baseline** for migrating SillyTavern's
`substituteParams()` macro engine to the miniAPP backend.

> **Frozen baseline** = the test cases here are written once and **kept stable
> for the entire project lifetime**. Both ST original and miniAPP migrated
> code must produce identical output for every case forever.

## Directory layout

```
packages/backend/test/fixtures/macros/
├── README.md                  ← you are here
├── schema/
│   ├── case.schema.json       ← JSON Schema for an input case
│   ├── baseline.schema.json   ← JSON Schema for a runner output bundle
│   └── types.ts               ← TS mirror of both schemas (IDE-only, not built)
├── cases/                     ← one JSON per case (filled in todo 3)
│   ├── macros-001-basic-char-user.json
│   ├── macros-002-...
│   └── ...
└── baselines/                 ← runner outputs (filled in todo 6)
    ├── sillytavern-original-YYYYMMDD-HHmm.json   ← truth, captured from ST browser
    └── miniapp-YYYYMMDD-HHmm.json                ← candidate, after Step 0.3
```

## Concept: 6-bucket input, 4-slot output

Every case is fully self-contained. Its `input` is split into **6 orthogonal
buckets** so a diff can pinpoint exactly which surface caused a regression:

| Bucket         | Purpose                                           | Example fields                                                            |
| -------------- | ------------------------------------------------- | ------------------------------------------------------------------------- |
| `template`     | The raw string passed to `substituteParams()`     | `"Hi {{user}}, this is {{char}} - {{description}}."`                      |
| `character`    | Character card fields                             | `name`, `description`, `personality`, `scenario`, ...                     |
| `user`         | User identity                                     | `name`, `personaDescription`                                              |
| `chat`         | Conversation history                              | `messages[]` (chat-macros read this)                                      |
| `chatMetadata` | Per-chat state                                    | `chatId`, `variables`, `pickRerollSeed`                                   |
| `settings`     | Runtime / preset state                            | `mainApi`, `modelName`, `maxPromptTokens`, `globalVariables`, `powerUser` |
| `options`      | substituteParams() options + determinism controls | `name1Override`, `dynamicMacros`, `seed`, `now`                           |

The `output` is split into **4 slots** to make diff failure modes easy to read:

| Slot                      | Diff role                                                                                                                   |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `output.text`             | **Primary** — must match byte-for-byte across both engines.                                                                 |
| `output.meta.macrosUsed`  | Sorted unique list of macros actually invoked. Useful when `text` matches but you want to confirm the right path was taken. |
| `output.meta.warnings`    | Lex/parse/runtime warnings from `MacroDiagnostics`.                                                                         |
| `output.meta.envSnapshot` | JSON-safe snapshot of `MacroEnv` after building. Used as a localization aid; **not** asserted bit-exactly.                  |
| `output.meta.error`       | Non-null when the case threw before producing output.                                                                       |

## Determinism / mocking contract

Several built-in macros are non-deterministic by default. The runner enforces
determinism by:

| Macro family                                                                                                                  | Mock strategy                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{{random}}`, `{{roll}}`                                                                                                      | `seedrandom(input.options.seed, { global: true })` overrides `Math.random` for the duration of the case, then restores it. `droll` uses `Math.random` so this also covers `{{roll}}`.               |
| `{{time}}`, `{{date}}`, `{{weekday}}`, `{{isotime}}`, `{{isodate}}`, `{{datetimeformat}}`, `{{idleDuration}}`, `{{timeDiff}}` | `moment.now = () => Date.parse(input.options.now)` overrides the moment clock, then restores it.                                                                                                    |
| `{{pick}}`                                                                                                                    | Already deterministic; seed = `chatIdHash + contentHash + offset + chat_metadata.pick_reroll_seed`. The case JSON must set `chatMetadata.chatId` and `chatMetadata.pickRerollSeed` to fix the seed. |

Cases that touch any of these macros **MUST** set `options.seed` and/or
`options.now`. Cases that don't touch them may omit those fields.

## Naming convention

| Element       | Format                                           | Example                                             |
| ------------- | ------------------------------------------------ | --------------------------------------------------- |
| `caseId`      | `macros-NNN-short-kebab-name`                    | `macros-001-basic-char-user`                        |
| Case file     | `<caseId>.json` under `cases/`                   | `cases/macros-001-basic-char-user.json`             |
| Baseline file | `<engine>-YYYYMMDD-HHmm.json` under `baselines/` | `baselines/sillytavern-original-20260429-1605.json` |

`NNN` is a zero-padded 3-digit serial. **Once a `caseId` is committed, it is
frozen forever** — never rename or renumber. Add new cases at the end.

## Workflow (Step 0 milestones)

| Milestone       | Owner | What happens                                                                                                                                                                                                                                |
| --------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.1             | done  | Schema + 9 cases + browser runner + sync script all in place.                                                                                                                                                                               |
| 0.2 (this step) | you   | Run the ST browser runner once. It produces a `baselines/sillytavern-original-macros-*.json` file — that file is **ground truth** for the whole project lifetime. See `packages/backend/test/baseline-runner/README.md` for exact commands. |
| 0.3             | dev   | Port `public/scripts/macros/{engine,definitions}/` into `packages/backend/src/prompt-engine/macros/` (剪线式硬搬). Expose `substituteParams.ts` façade.                                                                                     |
| 0.4             | dev   | Re-run same cases through the miniAPP engine, produce `baselines/miniapp-macros-*.json`. Diff `output.text` against the ST baseline. Zero diff = Step 0 done.                                                                               |

### How to run the ST baseline runner (0.2)

Full instructions in `packages/backend/test/baseline-runner/README.md`. Short version:

```bash
# from miniAPP repo root
cd packages/backend
node scripts/sync-baseline-runner.mjs                 # copies runner + cases into ST runtime

# in another terminal
cd /Users/qj/python_project/SillyTavern_runtime
npm install   # only first time
npm start

# in your browser
# open http://localhost:8000, wait for ST to load
# open devtools console, paste:
#   import('/baseline-runner/adapters/macros.js').then(m => m.run())

# the browser will download:
#   sillytavern-original-macros-YYYYMMDD-HHmm.json

# move it into:
#   packages/backend/test/fixtures/macros/baselines/
```

The downloaded file conforms to `schema/baseline.schema.json`. Once committed
under `baselines/`, treat it as **immutable ground truth** — even if ST later
changes its macro engine behavior in some upstream version, our project is
pinned to this baseline.

## Don'ts

- ❌ Don't rename a `caseId` after it's committed (breaks historical baseline files).
- ❌ Don't edit a case's `template` or `input` after a baseline is recorded — make a new case instead.
- ❌ Don't remove `options.seed` / `options.now` from a case that touches random/time macros.
- ❌ Don't put values in `input` that aren't strictly needed by the template — keep cases minimal so failures localize.
- ❌ Don't manually write or edit baseline JSON files — they must come from the runner, full stop.

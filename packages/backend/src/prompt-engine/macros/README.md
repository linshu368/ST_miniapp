# Macro Engine (Step 0.3 — 剪线式硬搬)

This subtree is a **byte-close port** of SillyTavern 1.17.0's
`public/scripts/macros/` directory. The engine code (`engine/`) and
the built-in definition modules (`definitions/`) are imported here
1:1; only their **import lines** are rewired to the local `runtime/`
shim, which replaces ST's browser globals (`script.js`, `power-user.js`,
`group-chats.js`, `lib.js`, …) with a caller-injected context.

> The single public API for the rest of the backend is the
> **TypeScript façade** at `../substituteParams.ts`. Nothing under
> `packages/backend/src/**` should `import` directly from this subtree.

## Directory layout

```
src/prompt-engine/macros/
├── README.md                  ← you are here
├── tsconfig.json              ← stricter check (allowJs+checkJs+strict)
├── macro-system.js            ← initRegisterMacros() — Step 0 entry
│
├── engine/                    ← copied 1:1 from ST, only imports patched
│   ├── MacroLexer.js          (chevrotain → runtime/lib.js)
│   ├── MacroParser.js         (chevrotain → runtime/lib.js)
│   ├── MacroCstWalker.js      (utils → runtime/utils.js)
│   ├── MacroEngine.js
│   ├── MacroRegistry.js       (utils → runtime/utils.js)
│   ├── MacroEnvBuilder.js     (script.js / group-chats → runtime/host.js)
│   ├── MacroEnv.types.js
│   ├── MacroFlags.js
│   └── MacroDiagnostics.js    (UI popup stripped, headless no-op)
│
├── definitions/               ← Step 0 macro standard library
│   ├── core-macros.js         ({{input}} → getUserInput())
│   ├── env-macros.js          ({{mesExamples}} short-circuited to raw)
│   ├── chat-macros.js         ({{firstDisplayedMessageId}} → null)
│   ├── time-macros.js
│   └── variable-macros.js     (SillyTavern.getContext → runtime/variables)
│
└── runtime/                   ← caller-injected context shim
    ├── lib.js                 ← chevrotain / seedrandom / droll / moment re-exports
    ├── host.js                ← chat / chat_metadata / name1 / name2 / power_user /
    │                              groups / extension_prompts / characters /
    │                              setRuntimeCtx + resetRuntimeCtx +
    │                              getCharacterCardFieldsLazy + isMobile + getUserInput
    ├── utils.js               ← getStringHash / isFalseBoolean / isTrueBoolean /
    │                              escapeRegex / timestampToMoment
    ├── i18n.js                ← t = identity
    ├── constants.js           ← inject_ids subset
    └── variables.js           ← variables.local / variables.global ({set,get,del,…})
```

## What was cut, and why

The `剪线清单` (cut list) from `Prompt 引擎迁移总纲` enumerated every
external symbol the macro subtree pulled from the rest of ST. Each
one was replaced exactly as planned:

| Original ST import                                                                                                                                                                                                                               | Replacement                                                            | Notes                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `'../../../script.js'` — chat / chat_metadata / main_api / extension_prompts / getMaxPromptTokens / getMaxContextTokens / getMaxResponseTokens / getCurrentChatId / name1 / name2 / characters / getCharacterCardFieldsLazy / getGeneratingModel | `'../runtime/host.js'` (live ESM bindings, mutated by `setRuntimeCtx`) | All 12 symbols are now ctx-driven.                                                                                                                                                                         |
| `'../../power-user.js'` — power_user                                                                                                                                                                                                             | `'../runtime/host.js'`                                                 | Only the macro-engine-relevant fields (`persona_description`, `instruct.*`, `sysprompt.*`, `context.example_separator`, `experimental_macro_engine`, `prefer_character_*`, `collapse_newlines`) are wired. |
| `'../../../scripts/group-chats.js'` — groups / selected_group                                                                                                                                                                                    | `'../runtime/host.js'`                                                 | Step 0 leaves these defaulted to `[]` / `null`.                                                                                                                                                            |
| `'../../RossAscends-mods.js'` — isMobile                                                                                                                                                                                                         | `runtime/host.js` `isMobile()` returns `false`                         | Backend is never mobile.                                                                                                                                                                                   |
| `'../../textgen-settings.js'` — textgenerationwebui_banned_in_macros                                                                                                                                                                             | `'../runtime/host.js'`                                                 | Mutable array, caller can read post-substitute to harvest banned tokens.                                                                                                                                   |
| `'../../instruct-mode.js'` — formatInstructModeExamples / parseMesExamples                                                                                                                                                                       | dropped (Step 0)                                                       | `{{mesExamples}}` short-circuits to `mesExamplesRaw`; full instruct-mode formatting is wired back in Step 1.                                                                                               |
| `MacrosParser` legacy class, Handlebars registration                                                                                                                                                                                             | dropped                                                                | Pre-engine relic; never re-implemented.                                                                                                                                                                    |
| `document.querySelector` (`{{input}}`, `{{firstDisplayedMessageId}}`)                                                                                                                                                                            | `getUserInput()` / `null`                                              | No DOM on backend.                                                                                                                                                                                         |
| `'/scripts/i18n.js'` — t                                                                                                                                                                                                                         | `'../runtime/i18n.js'` (identity)                                      | Diagnostics flow into logs, not UI.                                                                                                                                                                        |
| `'/scripts/popup.js'`, `'/scripts/util/AccountStorage.js'`, `'/scripts/util/SimpleMutex.js'` (used by MacroDiagnostics' onboarding popup)                                                                                                        | dropped, replaced with no-op `onboardingExperimentalMacroEngine()`     | Backend always runs with the new engine; no UI to onboard.                                                                                                                                                 |
| `'../../events.js'`, `'/scripts/extensions.js'` (state-macros)                                                                                                                                                                                   | NOT registered in Step 0                                               | Re-enabled in Step 1 if needed.                                                                                                                                                                            |
| `SillyTavern.getContext().variables`                                                                                                                                                                                                             | `'../runtime/variables.js'`                                            | Same `{ local, global }.{ get, set, del, add, inc, dec, has }` shape, backed by `chat_metadata.variables` (local) and a caller-injected store (global).                                                    |

## How the host shim works

`runtime/host.js` exports module-level `let` bindings (`chat`,
`chat_metadata`, `name1`, …). ESM live-binding semantics mean every
`import { chat } from '../runtime/host.js'` site sees the **current**
value, even when `setRuntimeCtx({ chat: newArr })` reassigns the
binding.

The TS façade calls `setRuntimeCtx(patch)` before evaluation and
`resetRuntimeCtx(snapshot)` in a `finally` block — so a thrown handler
or a nested baseChatReplace can never leak ctx into a sibling call.

`getCharacterCardFieldsLazy()` lives in `host.js` because it must call
back into the **current** substituteParams to do `baseChatReplace`.
That callback is injected on the way in via `setRuntimeCtx({
substituteParams: …})`, breaking the import cycle.

## TypeScript

The macro subtree is `.js + JSDoc` to keep the diff against ST tiny.

- `tsconfig.json` here turns on `allowJs + checkJs + strict +
noUncheckedIndexedAccess` and is run as `pnpm typecheck:macros`.
- The main backend pipeline (`tsc --noEmit`) sees `allowJs:true,
checkJs:false` and **excludes** this subtree, so it never has to
  type-check 5k+ lines of ported JS just to validate the rest of the
  backend.

## Validation (Step 0.4) — DONE, 9/9 full-pass

Two npm scripts in `packages/backend/package.json` close out Step 0:

```bash
# from packages/backend/
pnpm macros:baseline   # tsx scripts/run-miniapp-baseline.mjs
                       # → writes baselines/miniapp-macros-YYYYMMDD-HHmm.json
pnpm macros:diff       # node scripts/diff-baselines.mjs
                       # → diffs latest miniapp baseline vs latest ST baseline
pnpm macros:verify     # both, in sequence
```

`run-miniapp-baseline.mjs` re-executes every case in
`test/fixtures/macros/cases/index.json` through the ported engine
under the **same determinism mocks** the ST browser runner uses
(seedrandom-driven Math.random, pinned moment.now, position-stable
{{random}} handler shim — see `scripts/_lib/macro-baseline-helpers.mjs`).

`diff-baselines.mjs` checks four output slots per case:

| Slot                      | Gate? | Status (against `sillytavern-original-macros-20260429-2022.json`) |
| ------------------------- | :---: | ----------------------------------------------------------------- |
| `output.text`             | hard  | ✅ 9/9 byte-equal                                                 |
| `output.meta.macrosUsed`  | soft  | ✅ 9/9 set-equal                                                  |
| `output.meta.warnings`    | soft  | ✅ 9/9 array-equal (all empty)                                    |
| `output.meta.envSnapshot` | soft  | ✅ 9/9 deep-equal                                                 |

Zero diff on every case ⇒ Step 0 closed.

## How the validation tooling fits together

```
test/fixtures/macros/cases/*.json               (9 frozen input cases)
            │
            ├── ST runtime ────► test/baseline-runner/adapters/macros.js
            │                      (browser, devtools console)
            │                      writes baselines/sillytavern-original-macros-*.json
            │
            └── miniAPP node ──► scripts/run-miniapp-baseline.mjs
                                   (Node.js / tsx, this repo)
                                   writes baselines/miniapp-macros-*.json
                                            │
                                            ▼
                                   scripts/diff-baselines.mjs
                                            │
                                            ▼
                                  HARD-PASS (text byte-equal)
                                  → Step 0 closed, move to Step 1
```

## Step 1+ TODO (deferred from cut list)

- Re-enable `state-macros.js` (eventSource / lastGenerationType).
- Re-enable `instruct-macros.js` + port `formatInstructModeExamples`
  - `parseMesExamples` so `{{mesExamples}}` returns formatted output
    instead of raw.
- Wire `groups` / `selected_group` and the group-card lazy fields
  inside `getCharacterCardFieldsLazy` for {{group}} chats.

/**
 * TypeScript mirror of case.schema.json + baseline.schema.json.
 *
 * NOTE: This file lives outside `backend/src` and is therefore NOT picked up
 * by `pnpm typecheck`. It exists for IDE intellisense and as a single source
 * of truth when the diff tool / runner are written in TS.
 *
 * If you change the JSON schema, change this file in lockstep.
 */

// ─── Sub-shapes (input bucket = 6 sub-objects) ──────────────────────────────

/** Mirrors ST character card fields read by env-macros.js + MacroEnvBuilder. */
export interface CharacterFields {
  /** Maps to ST name2 / MacroEnv.names.char (unless overridden via options.name2Override). */
  name: string;
  description?: string;
  personality?: string;
  scenario?: string;
  /** Maps to MacroEnv.character.mesExamplesRaw. */
  mesExample?: string;
  firstMessage?: string;
  alternateGreetings?: string[];
  /** Character-level persona override. Falls back to user.personaDescription when empty. */
  persona?: string;
  /** Card-level system prompt override (data.system_prompt). */
  charPrompt?: string;
  /** Card-level post-history / jailbreak override (data.post_history_instructions). */
  charInstruction?: string;
  charDepthPrompt?: string;
  charCreatorNotes?: string;
  version?: string;
}

export interface UserFields {
  /** Maps to ST name1 / MacroEnv.names.user. */
  name: string;
  /** User-level persona text used when no character-level persona is set. */
  personaDescription?: string;
}

export interface ChatMessage {
  name: string;
  isUser: boolean;
  mes: string;
  swipeId?: number;
  swipes?: string[];
  extra?: Record<string, unknown>;
}

export interface ChatHistory {
  messages: ChatMessage[];
}

/** Mirrors ST chat_metadata. Used by {{pick}} and {{getvar}}/{{setvar}}. */
export interface ChatMetadata {
  /** Stable chat ID — feeds into {{pick}} seed. */
  chatId?: string;
  /** Per-chat scalar variables. */
  variables?: Record<string, string | number | boolean | null>;
  /** Maps to chat_metadata.pick_reroll_seed. */
  pickRerollSeed?: string | null;
  /** Forward-compat: tolerates extra ST metadata fields. */
  [key: string]: unknown;
}

/** Things macros read that aren't part of MacroEnv proper. */
export interface RuntimeSettings {
  mainApi?: 'openai' | 'kobold' | 'textgenerationwebui' | 'novel';
  /** Maps to MacroEnv.system.model (return of getGeneratingModel()). */
  modelName?: string;
  maxPromptTokens?: number;
  maxContextTokens?: number;
  maxResponseTokens?: number;
  /** Maps to extension_settings.variables.global. */
  globalVariables?: Record<string, string | number | boolean | null>;
  /** Subset of power_user actually consumed by macros (instruct/sysprompt/context). */
  powerUser?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Mirrors substituteParams options + determinism controls. */
export interface MacroOptions {
  name1Override?: string | null;
  name2Override?: string | null;
  groupOverride?: string | null;
  /** One-shot value for {{original}}. */
  original?: string | null;
  replaceCharacterCard?: boolean;
  /** Per-call additional macros. Keys lowercased internally. */
  dynamicMacros?: Record<string, string>;
  /** Deterministic seed for Math.random override. Required when template touches non-deterministic macros. */
  seed?: string;
  /** ISO 8601 timestamp to mock moment.now(). */
  now?: string;
}

// ─── Top-level case shape ────────────────────────────────────────────────────

export interface MacroEngineInput {
  template: string;
  character: CharacterFields;
  user: UserFields;
  chat: ChatHistory;
  chatMetadata: ChatMetadata;
  settings: RuntimeSettings;
  options: MacroOptions;
}

export interface MacroEngineCase {
  /** Format: 'macros-NNN-short-name' (e.g. 'macros-001-basic-char-user'). Frozen for project lifetime. */
  caseId: string;
  description: string;
  tags?: string[];
  input: MacroEngineInput;
}

// ─── Baseline output shape ───────────────────────────────────────────────────

export interface RunMeta {
  /** Wall-clock time when the runner started (ISO 8601). */
  runAt: string;
  /** Which engine produced this file. */
  engine: 'sillytavern-original' | 'miniapp';
  stVersion?: string;
  userAgent?: string;
  notes?: string;
  [key: string]: unknown;
}

export interface CaseMeta {
  /** Sorted unique list of macro names actually invoked. */
  macrosUsed: string[];
  /** Lex/parse/runtime warnings from MacroDiagnostics. */
  warnings: string[];
  /** JSON-safe snapshot of MacroEnv (for diff localization, not bit-exact). */
  envSnapshot?: Record<string, unknown>;
  /** Non-null when the case threw before producing output. */
  error: string | null;
}

export interface CaseOutput {
  /** Primary diff target. */
  text: string;
  meta: CaseMeta;
}

export interface CaseResult {
  caseId: string;
  /** Verbatim copy of MacroEngineInput; embedded for replayability. */
  input: MacroEngineInput;
  output: CaseOutput;
}

export interface MacroEngineBaseline {
  schemaVersion: '1.0';
  runMeta: RunMeta;
  results: CaseResult[];
}

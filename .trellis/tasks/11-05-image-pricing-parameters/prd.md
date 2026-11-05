# Persist image plaza pricing parameters

## Request

Save exchange, markup and credits-per-yuan alongside the image plaza model catalog; published values must survive reopening. User explicitly authorized immediate production release and required no behavioral impact on other modules.

## Scope and reuse

Extend the existing catalog schema and controlled Admin editor, existing draft/publish/rollback CLI path and existing pricing calculator. Add optional pricing_factors only in image_plaza_model_catalog. No new table, endpoint, service, dependency, general pricing framework or migration. Extract existing pricing panel only to satisfy file/function complexity limits.

## Compatibility and reliability

Old catalogs remain valid without pricing_factors; existing defaults are only a legacy fallback. New Admin/CLI share runtime validation. Preserve actual per-model credits and all existing values while initializing production factors to the user's latest 7.3/2.5/100. Manual prices remain authoritative; parameter editing does not silently recalculate them. Use existing optimistic draft/version checks, do not overwrite divergent drafts. Deploy Admin before publishing new optional JSON field; old backend ignores metadata and retains existing charge behavior. Rollback via previous Admin deployment and config release.

## Acceptance and verification

- Parameter edits enter the shared controlled draft and survive schema/JSON save/load, publish and rollback.
- Reopening published configuration shows saved values instead of resetting to 2.
- Existing one-click recalculation and manual price overrides keep their behavior; no changes to payment, chat, voice or user front end.
- Extend existing regression tests for 2.5 roundtrip, legacy catalog and invalid numeric parameters; run relevant tests, all consumer typechecks, Admin build and complexity check.
- Check production CLI before/after; preserve all model credits and standard USD prices exactly. Confirm deployed production asset includes the new persisted-parameter editor and runtime readback has 7.3/2.5/100.

## Review

Reviewed implementation scope against current main and production v3. User authorized direct release; no further approval gate required. Production manual Anime WAI price is 30 and must remain 30.

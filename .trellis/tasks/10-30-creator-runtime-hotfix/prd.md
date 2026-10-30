# Restore conversation entry

User approved urgent production recovery after creator release. Production PostgreSQL logs locate XX000 invalid memory allocation at read_character_runtime line 10; both new and existing conversation entry call this function. Preserve permissions, version freeze and creator rewards.

## Minimal change
Add one forward migration replacing whole-row to_jsonb(c) field extraction in read_character_runtime and bind_creator_character_version with direct character_persona_and_style text access. No new schema objects, row mutations, grants, API contracts or application rebuilds. Keep existing functions in app_core/experience. Production has this text column; test fixture must reflect it. Extend existing PG17 test, do not create another test system.

## Verification and recovery
Run existing isolated PG test with historical dropped-column shape and large unrelated JSON. Apply to TEST, then production using migration ledger; confirm readonly runtime calls do not expose prompt/body and live conversation error rate recovers. Migrations are atomic with short lock/statement timeouts. Forward fix only: reverting the known-broken projection would restore outage. Emergency restoration takes priority over application CI reruns unrelated to SQL.

## Review
Root and independent database/frontend reviewers agree on targeted cause and patch; approved for implementation under user emergency-repair instruction.

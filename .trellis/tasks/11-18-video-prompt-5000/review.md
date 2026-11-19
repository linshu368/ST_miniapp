# Final human review: video prompt5000

Proposed commit: `fix: support 5000-character video prompts`

Current branch: feat_video_park, tracking whc/feat_video_park. No staging, commit, push, remote migration, deployment or paid generation has occurred. Initial worktree was clean. All proposed paths below belong to this fix; no unrelated dirty paths identified.

## Concrete change

Shared new-video request/input max5000; historical snapshots unchanged; image request/input max2000 unchanged. Complete5000 submitted by mobile fixture;5001 rejected before repository/provider/billing. Existing E message content CHECK widens from1-2000 to1-5000 without changing data, grants, RLS, FKs, wallet or worker semantics. Extracted input reduces oversized studio function/file. See verification.md for test evidence and limits.

## Proposed release actions (require explicit final approval)

1. Commit exactly the paths below plus this review, push the reviewed work to whc/feat_video_park. No amend or unrelated merge/rewrite.
2. Verify the repository/workflow ref contains this exact migration. Dispatch Database Migration with mode=apply, environment=test, migration_file=packages/shared/migrations/20261118_media_plaza_message_prompt_5000.sql, force_rerun=false. Run same-name read-only postflight and check shape/ACL/lock/size evidence.
3. Only after TEST passes, use the same reviewed file for independently approved production (project wbtsfzozlmurljvglhpn), confirm_production=RUN_PRODUCTION_MIGRATION, force_rerun=false. Reconcile any unknown result instead of replaying blindly. Stop on shape drift, timeout or permission change.
4. Publish consumers through the existing repository release process after checking the complete PR scope and required CI. Do not deploy an arbitrary dirty checkout or merge unrelated changes. Read-only verify actual production version/constraint and error behavior. No paid generation or automatic retry of the failed requests.

Rollback consumers while retaining widened storage CHECK. Already stored long messages prevent safe blind shrink to2000. No truncation/deletion of user content. Remote concurrency, real Telegram keyboard/provider and P95 windows remain distinct gates.

Mandatory source: .trellis/workflow.md Phase3.4 requires final human review before git add/commit; database migration spec requires TEST verification and independent production confirmation. This packet is review material, not inferred approval.

## Final content digest and proposed file list

Files hashed: 27; review.md excluded from its own hash. Aggregate SHA256 of sorted path + NUL + file SHA256 + LF: `254e7fd6d96bb1deb2b1af7b4f706318c85a0d68f5d6a1e3dac0377db426ee75`. Any path/content change invalidates this review.

```text
b973f09419e92fb9bd8150859ec91ef5e1d9010d1ff6ed30daf3a43518534f2e  .trellis/spec/database/supabase/modules/business/conversation-storage.md
599f52d27890ca7435b3574cd6f6da9bb6694be6d07a3403499a19237d51e48a  .trellis/spec/database/supabase/modules/infrastructure/schema-security.md
b11c5b7379c1dfe60425f58f4e888945369a6c39f39a7b7bb118782d8fd7a2fc  .trellis/spec/frontend/app/modules/business/conversation-ui.md
12a5c99374595f5a66a69141c9f184acac770908a0ec81d57b7dcf0a64ca17e5  .trellis/spec/shared/contracts/modules/business/conversation-contracts.md
b07d08d236963962b98f02165f5c31eaaf15c70072b474458f952f1421887f6b  .trellis/tasks/11-18-video-prompt-5000/check.jsonl
0e0f05fa95b8e3248f0ab6169fed61a206d7ccd74c9d987c104bd281e38c1d61  .trellis/tasks/11-18-video-prompt-5000/design.md
b07d08d236963962b98f02165f5c31eaaf15c70072b474458f952f1421887f6b  .trellis/tasks/11-18-video-prompt-5000/implement.jsonl
e71e54785747527b29125f8b47062d990ab12c6ad6c1beb93cc20d92ac32979f  .trellis/tasks/11-18-video-prompt-5000/implement.md
b1eb25f8bfa6bb80f874079c45558a1827a7b6f907d1f389b839183531c2ee36  .trellis/tasks/11-18-video-prompt-5000/module-updates.json
48ce24a5f20ac4d1ab8dfdc93316cbbd5435651b08123609d07a531067491331  .trellis/tasks/11-18-video-prompt-5000/prd.md
eced484f9a104d6584805a7f09984003f367d60caf584e8e9a4c3af23bb3cf4b  .trellis/tasks/11-18-video-prompt-5000/task.json
f41110ab2c6eb37e37e5dc544288afe6d5049ce4eab07128f3c5d7b515f96bae  .trellis/tasks/11-18-video-prompt-5000/task.md
88ce5dc072dacac4e6c35573a70072719985d83631a4ccd797a1855c4bf32231  .trellis/tasks/11-18-video-prompt-5000/verification.md
b6b111aa305bdd3905f00b836e56770cc3d6bb5dcb68abf9d1d47c6a90823406  README.md
b6b0ba888f723f29b8f897e91684f061f45123e1ab74c2b6896cda69bc26d482  docs/ARCHITECTURE.md
c74fd8269c375a9f6dfc3496197dbec34e6a7ead0414797ad5e1e8cc5a85f798  docs/db/registry.yaml
3e5d89e990e1dc78ea5dc0a8468bd6ca09d00c66f9c7d21992e5c3bb07607b39  docs/video-plaza-stream.md
71084dfe82f133147c8edc73416102e1d667bb1ba1585f284699ef7b20f8a5e4  packages/backend/src/routes/image-plaza.test.ts
0ed10fd900d085c3a787b2b8c556fe7d74ebfc7a5e7f82600302c246385b3bb9  packages/frontend/src/app/(main)/create/studio/[conversationId]/page.tsx
29068ba4e13b57cece789f3f7c6573d365f80d8cb9cc8019862a007e259a07ce  packages/frontend/src/components/image-plaza/studio-prompt-input.tsx
84dc3f5ec58737d99203af6239fbadc4bbe0a05f3941d36906e331fad3f90ab3  packages/shared/migrations/20261118_media_plaza_message_prompt_5000.sql
f33d34da2461769e69b150a22e4ef25528da4bd4bdc9fc472f79709bbb26b623  packages/shared/migrations/README.md
3c9daa2d2af2d7bd366f68748b8c2a9d9bf761ee0643d976d0abcfc8bfb04fe1  packages/shared/migrations/tests/20261118_media_plaza_message_prompt_5000.sql
7fec3e6e33859165ac9b28f783b9c3dc8448d3fa11fc97f4e6e5720e9eece729  packages/shared/src/__tests__/video-plaza-contracts.test.ts
d8dcb87a47288835557b35cba200abb09a59b86cb1b53e295c1b541d82a41781  packages/shared/src/api/video-plaza.ts
58e90778a7e24f32935ab587f73c3ac479148cfb00e5ed7be6cf03c6c168f280  packages/ui-tests/tests/image.spec.ts
492fccbd52bb2c0c64818db2c97e435d8e2ee651dc60fbe6759fe289eab5b33c  scripts/test-video-prompt-5000.mjs
```

Also inspect and include this final review.md directly in the proposed commit. Archive/journal would be a separate later review, without automatic commit.

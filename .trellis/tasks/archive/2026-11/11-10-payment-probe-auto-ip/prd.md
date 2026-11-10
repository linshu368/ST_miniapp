# Automatic local IP for the payment probe

User requested removing PAYMENT_PROBE_CLIENT_IP configuration. The probe must generate a valid clientip itself without extra HTTP requests. Keep existing user payments and probe policies unchanged. Remove deployment/example/runtime references and update maintenance documentation.

Acceptance: no IP env setting needed; select a non-loopback local IPv4, fallback to 127.0.0.1 when none exists; one gateway create call; tests cover automatic selection and fallback; docs and archive updated. Local/container IP is not a verified public egress IP. No live upstream request or deployment in this task.

This is a narrow follow-up to the approved archived probe implementation. Existing tests may be extended; no new test files. Reuse decisions, validation and rollout limitations are in implementation-note.md. User request authorizes this correction directly.

Mobile performance: no page or user API work added, no network discovery. No visible Android/iOS/API P95 samples. Observe existing rollout metrics on enablement.

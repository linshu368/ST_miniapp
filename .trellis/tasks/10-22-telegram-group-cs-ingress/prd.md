# Telegram group CS ingress

## Requirements

Forward configured main Bot group/supergroup messages to standalone CS for independent batch classification before SOP. Never create a direct conversation, run an LLM, or reply to the group at ingress. Group details come later, so default disabled and empty allowlist must fail closed. Preserve identity, text/caption, image, reply, time and edit metadata. Anonymous senders have no direct-message user identity. Do not change webhook registration, Community Bot, database or production.

## Acceptance

- Disabled, empty allowlist, other groups, channels and malformed identities/times never forward.
- Allowed new/edited group messages reach the independent CS endpoint; edits keep chat/message identity.
- Group messages never call user creation or /start recording, including group /start.
- Group persistence failure returns 503 for Telegram retry; private behavior remains compatible.
- No message/response content or credentials in logs.
- Security and cross-service contract risk explicitly justify regression coverage in the existing Bot test plus focused service-client tests.

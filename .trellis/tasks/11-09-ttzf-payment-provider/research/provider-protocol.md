# Epay protocol source

Authority: user-supplied screenshots in this conversation on 2026-11-09, sections 1.1-1.4 and 3.1-3.6. User explicitly requested epay only. Original Google document could not be fetched (HTTP 401); screenshots provide the implementation facts recorded in design.md.

Endpoints are relative to https://ttzf8.com/api/: POST /epay/mapi.php for creation; /epay/api.php with act=order for single-order lookup. Epay notifications are signed GET requests; only TRADE_SUCCESS is paid and accepted/duplicate callbacks return success. Successful query has code=1, status=1 paid/status=0 unpaid. Money is yuan up to three decimals.

Sign every nonempty parameter except sign/sign_type/signType, ASCII ascending names, raw unencoded key=value pairs joined by &, direct application-secret suffix, lowercase MD5. Wire form encoding occurs after signature generation. pid is appId, not merchant number.

No documented batch query or native query. A prior body-only credential probe returned code 500 and did not verify POST support. After that limitation and the root secret-in-URL rule were explained, the user explicitly requested section 3.6's documented GET interface. The implementation therefore uses GET with act=order, pid, key and out_trade_no, only in a server-to-provider HTTPS request. No redirect, cache, URL logging or raw transport error propagation. Existing telemetry sanitization now also covers key/sign and standalone spans. No credential values or signed real payloads are recorded here.

Client IP: Railway public networking documents X-Real-IP as the client remote IP; fixed proxy hop count is not documented. Use validated X-Real-IP on Railway public HTTP ingress, socket IP locally; deployment must not expose untrusted direct/private/TCP ingress. Source: https://docs.railway.com/networking/public-networking/specs-and-limits#technical-specifications (read 2026-11-09).

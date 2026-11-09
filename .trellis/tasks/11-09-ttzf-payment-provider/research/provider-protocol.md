# Epay protocol source

Authority: user-supplied screenshots in this conversation on 2026-11-09, sections 1.1-1.4 and 3.1-3.6. User explicitly requested epay only. Original Google document could not be fetched (HTTP 401); screenshots provide the implementation facts recorded in design.md.

Endpoints are relative to https://ttzf8.com/api/: POST /epay/mapi.php for creation; /epay/api.php with act=order for single-order lookup. Epay notifications are signed GET requests; only TRADE_SUCCESS is paid and accepted/duplicate callbacks return success. Successful query has code=1, status=1 paid/status=0 unpaid. Money is yuan up to three decimals.

Sign every nonempty parameter except sign/sign_type/signType, ASCII ascending names, raw unencoded key=value pairs joined by &, direct application-secret suffix, uppercase MD5. Wire form encoding occurs after signature generation. pid is appId, not merchant number.

No documented batch query or native query. Query URL examples include key, which violates root secret-in-URL rules. A nonexistent-order query with body-only credentials returned application code 500, so authenticated POST lookup still needs provider verification. No credential values, signed production payloads or response business rows are recorded here.

# Audit: platform/middleware/auth.integration.test.ts (2026-11-24)

## What failed
"holds only an id in the cookie, puts the account on the request, and the socket handshake resolves the same account" failed in
ship's gather of every layer on 7719c9378: `expected 'koala_sid=s%3Ai4A6j-uyTR6lRCZz-7G89By2s-vOw7nK.sbHX2Z%2BlbrhWr6NkDVDnAtZPKDdyGu10kuRx74nYvSY' not to contain 'u1'`.
Its first failure (2026-11-21) left no reason in the record.

## The cause (test)
The case proved the cookie carries no account id by asserting the whole cookie does not contain `u1`. The cookie is a random
session id and its HMAC signature, about 75 characters of base64, so a two-character id turns up in it by chance: here in the
signature, "…Gy**u1**0k…". In a cookie that long, a given two-character string appears in about one run in 55, so the case
failed now and then whatever the code did. This time the code was right: the cookie held only a random id. What failed on
2026-11-21 is not known; the same chance is the likeliest cause.

## The fix
The case signs in an account whose id is `account-whose-id-the-cookie-never-holds`, saved in the case itself, and asserts the
cookie does not contain that id and that `/api/me` and the socket handshake both resolve to it. No random cookie can contain a
39-character id by chance, so the assertion fails only if the cookie really carries the account.

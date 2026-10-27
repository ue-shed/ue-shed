---
"@ue-shed/niagara": patch
---

The UEShedNiagara preview commandlet ends a render frame after every scene capture and session
request. Host-owned sessions no longer grow by about 400 MiB per request, and they log process commit
after each request. When auto-fit coverage already reaches the image edge, the capture now keeps the
bounds-based camera and logs a warning instead of failing; edge activity still sets `needsReview`.

# Issue #9 evidence

## Scope

Reviewed-manifest public delivery checks for HTTP, DNS, and TLS, including
SSRF, redirect, and DNS-rebinding defenses plus sanitized evidence.

## RED

- Command: `npm run test:unit`
- Exit: `1`
- Expected failure: the reviewed DFConnect manifest and public-delivery probe
  module did not exist.
- The public-delivery security matrix was present before implementation.

## GREEN

- Command: `npm run test:unit`
- Exit: `0`
- Result: 6 tests passed.
- The Issue test covers healthy HTTP/DNS/TLS results, metadata/private address
  rejection before transport, connected-IP mismatch, off-origin redirect, and
  credential-bearing manifest target rejection.

## LOCAL

- Caller can select only `siteId`, `environment`, and `checkId`: PASS
- Exact HTTPS origin and reviewed target manifest: PASS
- Apex, www, pricing, 404, robots, sitemap, known asset, DNS, and TLS entries:
  PASS (manifest compilation)
- All DNS answers must be globally routable: PASS
- Transport must attest a connected IP from the reviewed DNS answer set: PASS
- Redirects are manually validated at every hop: PASS
- 403, 429, 5xx, and transport failure remain `unknown`: PASS (policy path)
- Raw body, IP addresses, redirect location, header values, and query are
  absent from persisted evidence: PASS
- `npm run lint`: PASS, exit 0
- `npm run typecheck`: PASS, exit 0

## STAGING_REMOTE

`NOT_RUN` — no approved external probe provider, staging endpoint, region, or
connected-IP attestation transport was provisioned.

## PRODUCTION_REMOTE

`NOT_RUN` — no production request, DNS lookup, or TLS handshake was executed.

## Rollback / rehearsal

Revert this Issue's single commit. It creates no remote resource and does not
place Guard in the public request path.

## Unresolved blockers

- Production requires at least two approved probe locations, including one
  outside Cloudflare.
- A plain Worker `fetch()` does not expose the connected peer IP. The selected
  transport must provide trustworthy peer-IP attestation or pinning before any
  remote result can be accepted.
- The reviewed manifest still requires owner confirmation against the exact
  CMS production release SHA.

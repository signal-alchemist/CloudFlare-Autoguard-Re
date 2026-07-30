# CloudFlare-Guard

CloudFlare-Guard is the internal, read-only-first control plane for the
DFConnect owned-media platform. It turns fresh HTTP/DNS/TLS, Cloudflare, CMS,
notification, and deployment signals into component verdicts, incidents, and
operation gates.

It is deliberately independent from the public site and the Growth module:

- a Guard outage does not take the published static site down;
- a Guard outage does stop new merge, publish, and deploy side effects;
- CMS content, GA4/GSC data, Growth proposals, and contact PII never enter the
  Guard store;
- Guard does not execute DNS/WAF changes, D1 restore, R2 deletion, rollback, or
  unfreeze.

## Documents

- [Requirements](docs/01-requirements.md)
- [Basic design](docs/02-basic-design.md)
- [Issue/commit map](docs/03-issue-commit-map.md)

## Local development

Requirements: Node.js 24.

```bash
npm ci
npm run dev
```

Local validation:

```bash
npm run lint
npm run test:unit
npm run build
```

Remote Cloudflare resources, Access audiences, notification destinations, and
secrets are environment-owned values. They are never guessed or committed.


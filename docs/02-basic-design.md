# CloudFlare-Guard 基本設計書

最終更新: 2026-07-31

## 1. 設計方針

GuardをCloudFlare-CMSから独立したcontrol planeとして実装する。公開siteの
requestはGuardを経由しない。CMSは副作用直前にだけsigned gateを取得する。

Growth moduleはマーケティング事実・提案を所有し、Guardは稼働事実・incident・
freezeを所有する。DB、Queue、R2、credentialは共有しない。

## 2. 論理構成

```text
Independent HTTP/DNS/TLS probes ─┐
Cloudflare read-only adapters ────┼─> Observation intake/repository
CMS signed ops signal ────────────┤              │
Browser safe synthetic ───────────┘              ▼
                                          Verdict engine
                                             │      │
                                             ▼      ▼
                                        Incident   Gate
                                             │      │
                                      Alert Queue   └─> CMS
                                             │
                                             ▼
                                        Operators

External heartbeat ── watches Guard scheduler and alert path
```

## 3. Repository構成

```text
app/                         # Access配下read-only console
app/api/                     # canonical read APIとCMS互換endpoint
lib/contracts/               # strict runtime contracts
lib/domain/                  # vendor-neutral pure policy
lib/adapters/                # HTTP/DNS/TLS/CMS/Cloudflare/notification
lib/repositories/            # D1/R2/outbox
worker/                      # Cloudflare Worker entry
db/                          # D1 schema
drizzle/                     # generated migrations
config/sites/                # reviewed site/check manifest
tests/unit/                  # 1 child Issue = 1 test perspective
docs/evidence/               # LOCAL/STAGING_REMOTE/PRODUCTION_REMOTE
```

`lib/domain`からCloudflare、network、storage、Next.jsをimportしない。

## 4. 主要データ

### Observation

```ts
type Observation = {
  schemaVersion: 1;
  observationId: string;
  siteId: string;
  environment: "staging" | "production";
  component: Component;
  checkId: string;
  status: "pass" | "fail" | "degraded" | "unknown" | "unsupported";
  reasonCode: string;
  observedAt: string;
  validUntil: string;
  source: string;
  scope: string;
  evidenceId: string;
  correlationId: string;
  idempotencyKey: string;
};
```

Observationはappend-only。訂正は新recordで行う。

### ComponentVerdict

Observation IDの集合、policy version、decision traceを保持する。同じ入力と
policy versionから同じ結果を返す。

### Incident

fingerprintは
`siteId/environment/component/reasonCode/scope`から標準SHA-256で生成する。
timelineとauditはappend-onlyとする。

### Gate

canonical gateは4 operationを持つ。現CMS互換projectionはcontentPublishと
siteDeployだけをepoch秒/HMAC形式で返す。

## 5. Signal受付設計

現CMSは次を送る。

```json
{
  "schema": "autoguard-ops-signal-envelope-v1",
  "environment": "staging",
  "signal": {
    "schema": "ops-signal-v1",
    "event": "worker.runtime_failure"
  },
  "sentAt": "2026-07-31T00:00:00.000Z"
}
```

処理順:

1. body上限とJSONを検証
2. Bearer tokenからserver-owned site/environment scopeを取得
3. stable JSON HMACをtiming-safeに検証
4. sentAt clock skew、envelope environment、strict signal schemaを検証
5. signal identityからidempotency keyを生成
6. allowlist sanitizerでObservation/evidence metadataへ変換
7. D1 transactionでObservation、receipt、audit、outboxを保存
8. duplicateは既存receiptを返す

互換v1に不足するaudience/nonce/expiryはcredential scope、clock window、
signal identity dedupeで補う。v2で明示fieldへ移行する。

## 6. Component mapping

| Signal/check | Component |
|---|---|
| apex/route/redirect/DNS/TLS | `public_delivery` |
| admin/auth/repository/CI | `editorial` |
| `/api/contact`/D1/Turnstile | `contact_intake` |
| `/img/*`/R2/Images | `media_delivery` |
| contact delivery/Queue/DLQ/provider marker | `notification_delivery` |
| `/healthz` SHA/Worker/route/binding/migration | `deployment_integrity` |
| prior version/bookmark/rehearsal | `recovery_readiness` |
| scheduler/D1/R2/Queue/alert heartbeat | `autoguard_control_plane` |

## 7. Verdict algorithm

1. check definitionからrequired sourceを列挙
2. schema/signature/site/environment/source allowlistを検証
3. server policyからeffective validUntilを算出
4. stale/missing/invalid/unknownをhealthy候補から除外
5. multi-vantage quorumと連続failure/recovery windowを適用
6. maintenanceは対象checkだけへ適用
7. component verdictとreason codeを生成
8. incident/freeze transitionを生成
9. operation matrixでgateを`allow | deny`へ決定

判定内でnetwork、storage、LLM、現在時刻取得を行わず、clockを引数で渡す。

## 8. API

| Method/path | 用途 |
|---|---|
| `POST /v1/signals/cms` | signed CMS ops signal |
| `GET /v1/sites/:siteId/environments/:env/operability` | canonical state |
| `POST /v1/gate-evaluations` | strict OperationContext gate |
| `GET /v1/incidents` | sanitized incident list |
| `GET /v1/incidents/:id` | timeline |
| `POST /v1/post-deploy-checks` | exact-SHA verification request |
| `GET /compat/v1/gate` | current CMS-compatible HMAC projection |
| `GET /live` | process liveness only |
| `GET /ready` | D1/R2/Queue/credential/scheduler readiness |

Internal routesはAccessまたはservice authentication失敗時にgeneric 401/403を
返す。header自己申告だけからrole/siteを作らない。

ConsoleのCloudflare Access modeは`Cf-Access-Jwt-Assertion`の存在だけを
信用せず、Access issuerのJWKSでRS256署名、issuer、audience、有効期限を
Worker内で検証する。site/environmentはJWTやclient headerから採用せず、
deployment設定の`GUARD_SITE_ID`と`GUARD_ENVIRONMENT`で固定する。認証後は
Access JWT、認証email、Cookie、Authorizationをrendererへ渡さない。

HTMLにはrequestごとのnonceを発行し、vinextへ同じCSPをrequest headerで
渡して全scriptへnonceを付与する。responseは同一nonceのCSP、
`private, no-store`、frame拒否、no-referrer、nosniff、機能制限、
noindexを返す。Access失敗responseにも同じ安全headerを付ける。

## 9. Persistence

- D1: sites、checks、observations、receipts、verdicts、incidents、timeline、
  freezes、jobs、outbox/inbox、audit
- private R2: failure screenshot等のlarge sanitized evidence
- Queue/DLQ: check jobとalert deliveryを分離

raw response、contact data、secretをD1/R2/Queueへ保存しない。

## 10. Console基本画面

```text
┌ Site / Environment / Last refresh ───────── Gate summary ┐
│ Overall: unknown  | Publish DENY | Deploy DENY            │
├ Component grid ────────────────────────────────────────────┤
│ Delivery  Editorial  Contact  Media  Notification ...     │
├ Active incidents ────────────────┬ Evidence freshness ─────┤
│ SEV / reason / owner / age       │ source / age / status   │
├ Deploy integrity ────────────────┴ Guard readiness ────────┤
│ expected SHA / active SHA / Queue / D1 / R2 / heartbeat    │
└ Read-only. No unfreeze / rollback / restore controls. ─────┘
```

desktop/mobileで情報順を維持し、状態は色、icon、text labelを併用する。

## 11. Deployment

- production/stagingは別D1/R2/Queue/DLQ/Access audience/secretを使う。
- Consoleは`CONSOLE_AUTH_MODE=cloudflare-access`、
  `CONSOLE_ACCESS_ISSUER`、`CONSOLE_ACCESS_AUDIENCE`を必須とする。未設定、
  JWT失敗、scope不一致はfail-closedとする。
- owner-only Sites previewは`sites-private` modeを使えるが、Cloudflare
  Accessの代替ではなく、直origin遮断をremoteで確認するまで本番Access
  evidenceに数えない。
- Guard WorkerはCloudflare read-only inventory tokenだけを持つ。
- CMS deploy/recovery tokenをGuardへ渡さない。
- stagingでfailure matrixとnotification rehearsal後にproduction shadowへ進む。
- production gateは14日以上のshadow evidenceとowner承認後に有効化する。

## 12. 既存CMSとの不整合と方針

CMSの`src/contracts/v1.ts`はsingle gate/ISO時刻、実consumerの
`worker/growth/operational-gate.ts`はgate map/epoch秒/freeze/HMACである。
MVPは実consumer contractを`OperationalGateCompatV1`として固定し、
canonical APIと混在させない。consumer-driven testをrelease blockerとする。

CMS ops envelope v1にはsiteId/audience/nonce/expiryがない。MVPはcredential
bindingとfreshness/dedupeでfail-closed補完し、v2 migrationを別Issueで行う。

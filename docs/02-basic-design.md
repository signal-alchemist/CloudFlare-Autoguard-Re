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
7. D1 transactionでObservation、receipt、auditを保存
8. duplicateは既存receiptを返す

互換v1に不足するaudience/nonce/expiryはcredential scope、clock window、
signal identity dedupeで補う。v2で明示fieldへ移行する。

現CMSはsignal送信とGate取得に同じ`AUTOGUARD_ENDPOINT`を使うため、
`POST /compat/v1/gate`を`POST /v1/signals/cms`と同じingress handlerへ
method dispatchする。`GET /compat/v1/gate`は既存Gate handlerを維持する。
signal用credentialは`CMS_SIGNAL_SERVICE_TOKEN` /
`CMS_SIGNAL_SIGNING_SECRET`を優先し、両方が未設定の場合だけ現CMS移行用に
Gate credential pairを使う。片方だけの設定、credential/D1 binding欠損、
D1障害は`503`とし、Observationを受理したように返さない。

Signal HTTP responseは`accepted=202`、fresh retryによる同一Observationは
`duplicate=200`、auth/signatureはgeneric `401`、scopeは`403`、exact-body
replayは`409`、strict body/freshness違反は`400`、body上限超過は`413`、
content type違反は`415`とする。全responseをJSONかつ`no-store`にする。

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

Live state repositoryはdeployment固定のsite/environment/policy allowlistだけを
D1から取得する。各component/check/sourceの最新`observedAt`を選び、同時刻の
recordは全件をpure evaluatorへ渡してconflictを`unknown`にする。Verdictは
`component_verdicts`へcurrent projectionとしてmaterializeし、Gate読取ごとに
明示clockで再評価する。D1 read/write、row schema、policy scopeの不整合時は
過去のhealthyへfallbackせずdenyへ倒す。

Freezeはsite/environment固定で、`releasedAt`がなく、canonicalな
`activatedAt <= now < expiresAt`を満たす期限付きrecordだけをactiveとする。
期限切れfreezeはactiveにせず、破損した未release recordはstate不明として
Gateをdenyする。productionの初期reviewed policyはpublic delivery manifestの
9 checkを`public_probe + external_probe`の2地点必須にする。CMS ops signalは
failure-onlyなのでhealthyを証明するrequired sourceには使用しない。

### 7.1 Scheduled public-delivery producer

default Guard WorkerはUTC 1分間隔のCronから`scheduled()`を実行する。target、
site、environment、check IDはrequestや環境変数から構築せず、
`config/sites/dfconnect.production.ts`をstrict compileした9 checkだけを
最大4並列で実行する。

```text
Cron scheduledTime
  -> exact site/environment/cron validation
  -> checked-in manifest compile
  -> DNS A/AAAA observation + manual-redirect HTTP fetch
  -> per-check sanitized Observation
  -> D1 receipt/audit
  -> all 9 persisted
  -> autoguard_self scheduler heartbeat PASS
```

scheduled Observationのlogical keyは
`site/environment/scheduledTime/checkId`で固定する。retry時は既存keyを先に
読み、同じtickで結果を増殖させない。raceした異なる結果は上書きせず
idempotency conflictへ倒す。target保存の一部でも失敗した場合、可能なら
`scheduled_cycle_incomplete`のUNKNOWN heartbeatを残し、PASS heartbeatは
作らない。

Workers adapterは2つのtransport能力を混同しない。

| 能力 | Worker scheduled source |
|---|---|
| A/AAAA、TTL | `node:dns`の`resolve4` / `resolve6`で観測可能 |
| HTTP status/header/body/redirect/latency | `fetch`、manual redirect、bounded body |
| 実接続IP | Workers `fetch`では取得不能 |
| TLS certificate/protocol/expiry/SNI | Workers `fetch`では取得不能 |

HTTP/securityの明確な不一致は不足証明があってもFAILを優先する。timeout、
network error、403、429、5xx、body decode不能はUNKNOWNとする。HTTPが全て
一致しても実接続IP/TLSが取得不能なWorker sourceはUNKNOWNであり、偽の値を
入れてPASSにしない。外部のfully-attested probeは別sourceとして維持する。

scheduler heartbeatのPASSはscheduler起動、全check試行、D1保存完了だけを
表し、siteやGuard全体のhealthyを意味しない。audit actorはCMS ingressと分け、
`scheduled-public-producer` /
`dfconnect-public-delivery-v1`で記録する。

### 7.2 Post-deploy runtime identity

CMS runtime identityは独立probeが確認した
`commitSha / workerVersionId / evidenceDigest`だけを
`deployment_runtime_identities`へappendする。request値やSites環境変数から
server-owned identityを生成しない。scopeの最新recordだけを読み、missing、
stale、または3値の1つでも不一致なら`unknown`とし、古い一致recordへ
fallbackしない。

identityは固定policy `deployment-runtime-identity-v1`、最大300秒、
future skew 30秒に限定し、source Observationとの外部キーで独立証跡へ結ぶ。
3値が完全一致した後だけlive `siteDeploy` Gateを評価し、identityとGateの
短い方のfreshnessをallow receiptへ使う。

identity/Gate D1障害と内部障害はserver詳細を捨ててgeneric `503`、
missing/stale/mismatchは`post-deploy-evaluation-v1`の`unknown`を`503`で返す。
auth/signatureは`401`、scopeは`403`、request ID conflictは`409`、malformed
requestは`400`とする。duplicate/restartでは保存済みreasonを返し、checkerを
再実行しない。

### 7.3 Maintenance request and expiring freeze

現CMSの`maintenance-request-v1`は
`POST /v1/maintenance-requests`で受付する。requestは9 fieldをstrictに固定し、
recursive key sortしたcanonical JSONと送信body bytesが完全一致する場合だけ、
Bearer credentialとraw body HMAC-SHA256を検証する。requestは最大300秒、
future skew 30秒、`expiresAt - requestedAt`は1〜900秒、受付時点で期限内に
限定する。

maintenance credentialは`CMS_MAINTENANCE_SERVICE_TOKEN` /
`CMS_MAINTENANCE_SIGNING_SECRET`のpairを優先する。pairの両方が未定義の場合
だけ現CMS移行用にGate credential pairへfallbackする。dedicated pairの片側
だけが定義された場合、空値、不正値、D1/scope binding欠損ではfallbackせず
generic `503`とする。post-deploy credentialへはfallbackしない。

最初のrequestはD1の1 batchでrequest、期限付きfreeze、両者のlink、signed
receipt、auditを同時に作る。途中のconstraint/D1 failureではbatch全体を
rollbackする。同じ`requestId`と同じcanonical digestは保存済みreceiptを返し、
freeze、receipt、auditを増殖させない。同じ`requestId`でbodyが違う場合は
`409 idempotency_conflict`とし、別freezeを作らない。

receiptは現CMS互換の
`maintenance-request-receipt-v1 / maintenance.requested.receipt /
accepted`だけを返す。初回は`202`、duplicateは同じ署名済みreceiptを`200`で
返す。auth/signatureは`401`、scopeは`403`、malformed/freshness/expiryは
`400`、body上限は`413`、content typeは`415`、内部障害はgeneric `503`とする。

freezeはserver受付時刻を`activatedAt`、signed requestの期限を`expiresAt`、
`requestId`をcorrelation IDとしてappendする。既存のhalf-open判定
`activatedAt <= now < expiresAt`により期限ちょうどで自然失効し、rowは
audit evidenceとして残す。このAPIはactivate-onlyであり、release/unfreeze/
override endpoint、repository method、AI toolを提供しない。将来の人間による
期限前解除は別Issue、別強認証、別auditとする。

### 7.4 FAIL Incident reconciliation and notification outbox

Incident化の入口は保存済みObservationだけとし、判定条件を
`observation.status === "fail"`に固定する。受信signalの`severity`は
Incidentへ渡さない。checked-in `incident-severity-v1`は自動SEV-1を禁止し、
次の初期値を返す。

| Scope/component | Severity |
|---|---|
| stagingの全component | `sev3` |
| productionのpublic delivery/contact intake/notification delivery/deployment integrity/control plane | `sev2` |
| productionのeditorial/media/recovery readiness | `sev3` |

```text
persisted FAIL Observation
  -> server severity + canonical incident fingerprint
  -> D1 one batch
       ├─ Incident (fingerprint unique)
       ├─ observation_recorded timeline
       └─ sanitized pending notification_outbox
  -> no Queue/provider call in Issue #28
```

唯一の書込操作は`recordFailureAndPendingNotification`とし、従来の
`recordFailure`の後から別batchでoutboxを足す呼出は禁止する。
`notification_outbox`はIncidentとsource Observationへrestrictive foreign keyを
持ち、`UNIQUE(incident_id, notification_kind)`で`incident_opened`を1件に固定
する。statusは`pending | enqueued | blocked`、pending scan indexは
`status/created_at/outbox_id`とする。payloadは
`toSafeNotification`から`compileNotificationDelivery`したcanonical JSONと
SHA-256 digestだけを保持する。

同じObservationの再処理はIncident/timeline/outboxを増やさない。同じ
fingerprintの別FAILはtimelineだけを増やし、既存outboxのsource evidenceと
payloadを維持する。Incident stateが後から変わっても同じoutbox keyのpayloadを
再計算しない。row、timeline、payload/digestの不一致は上書きせずcorruption
としてfail-closedにする。

CMSの初回acceptedとfresh-envelopeによるObservation duplicateの両方で
reconcileする。reconcile失敗はObservation receiptを取り消さずgeneric `503`を
返し、次のfresh retryで欠損を修復する。raw bodyが同一のreplayは従来どおり
`409`であり、fresh-envelope duplicate `200`とは区別する。

scheduled producerは新規・既存の各FAILをreconcileした後だけcycleを完了する。
reconcile失敗時は可能なら`scheduled_cycle_incomplete` UNKNOWN heartbeatを
残し、PASS heartbeatを作らない。各cycle開始時に、timelineまたはoutboxが
欠けた保存済みFAILを最大32件repairするため、CMS retry喪失後も回復できる。
repairはWorkerに固定されたsite/environmentだけを対象とし、Observationの
`site_id/environment/status/created_at/observation_id`複合indexを使う。
誤って共有されたD1でも別scopeへ書き込まない。

resolved Incidentと同じfingerprintの新しいFAILは、resolved stateを
`incident_opened`として通知し直さない。episode ID、reopen transition、
通知kind/idempotencyの契約は別Issueで定義し、それまでは
`incident_reopen_required`でfail-closedにする。migration `0007`より前に
解決済みでopening timelineだけが存在するIncidentは、新たな遅延通知を送らず
`incident_resolved_before_outbox`の`blocked` rowを作ってrepair対象から外す。

### 7.5 Notification dispatch and reviewed HTTP provider

Issue #29は既存`notification_outbox`と`notification_deliveries`を利用し、
新しいmigrationを追加しない。scheduled cycleはpublic-delivery producerの
Observation、Incident reconciliation、PASS heartbeat保存を先に完了し、その後に
通知dispatchをbest-effortで試す。Queue binding欠損、Queue send失敗、outbox
scan/CAS障害は通知を遅延させるが、完了済みのpublic監視結果を失敗へ書き換えない。

```text
scheduled public producer + persisted heartbeat
  -> scoped pending scan (created_at/outbox_id, max 10)
  -> canonical envelope + SHA-256 digest + server scope verification
       ├─ corrupt: blocked / notification_outbox_payload_invalid
       └─ valid: Queue.send(envelope object, contentType=json)
                    -> exact snapshot CAS pending -> enqueued

configured Queue consumer
  -> expected batch.queue + server scope
  -> exact local outbox + Incident + source FAIL Observation authorization
  -> reviewed HTTPS provider POST (5 s, manual redirect, no body read)
       ├─ 2xx -> D1 http_2xx marker -> ACK
       ├─ 429 / 5xx / timeout -> bounded retry
       └─ 3xx / other 4xx / invalid / conflict -> poison retry -> DLQ
```

pending scanはIncident join内で`site_id/environment`をSQL条件に固定し、別scope
rowが先頭にあっても自身の最大10件を選ぶ。Queue送信前に
`compileNotificationDelivery`でbodyを再canonical化し、保存body/digest、
incident ID、site/environmentを照合する。破損内容や例外は返さず、固定reason
だけを保存する。

Queue送信後の状態変更はoutbox ID、Incident、Observation、kind、body、digest、
created/updated timestamp、`status='pending'`、`enqueued_at IS NULL`、
`last_error_code IS NULL`とserver scopeを比較するCASとする。0件更新は、同じ
snapshotが既に同一terminal stateへ遷移済みと再照合できた場合だけ冪等成功と
し、それ以外をconflictとしてpending相当の再試行へ残す。
timestampやpending NULL不変条件自体が既に破損したrowは送信CASへ渡さず、
raw snapshot全fieldとserver scopeを比較する隔離専用CASで固定blocked codeへ
収束させる。最古の破損rowを理由に同じscan内の後続valid rowを停止しない。

consumer authorizationはQueue payloadの形式検証だけに依存しない。canonical
body/digestと`outbox:<incident>:incident_opened`をlocal D1で検索し、statusが
pending/enqueued、Incidentのcomponent/reason/scope/severity/openedAt、および
source FAIL Observationのsite/environment/component/reason/scope/evidence/
observedAt/correlationがenvelopeと一致することをproviderより先に確認する。
同じscopeらしく見えるfabricated messageや別environmentのmessageも送信しない。

HTTP providerは`NOTIFICATION_PROVIDER_ENABLED`が文字列`true`のときだけ作る。
endpoint/tokenは`NOTIFICATION_PROVIDER_ENDPOINT`とsecret
`NOTIFICATION_PROVIDER_TOKEN`から読み、client/Queue/D1へ保存しない。endpoint
はoperator review済みのHTTPS URL 1件とし、IP literal、localhost、userinfo、
query、fragment、control character、非default portを拒否する。redirectは
manualのためcredentialを別originへ追従送信しない。responseからはstatusと
1〜9桁のnumeric Retry-Afterだけを採用し、bodyは読まない。

Queue consumerは`NOTIFICATION_QUEUE_NAME`とruntimeの`batch.queue`を一致させる。
DB、site/environment、Queue名、enable/endpoint/tokenの欠損・不正、および
別Queue batchは5秒delayでbatch全体をretryし、message単位ACK/retryやprovider
呼出をしない。Cloudflare側の`max_retries=3`と専用DLQで最終隔離する。

checked-in queue planはlocal runtimeをready、remote resourceを
`remote-unprovisioned`、staging/production evidenceを`NOT_RUN`と明記する。
Sitesが生成する`dist/server/wrangler.json`にQueue bindingは現時点で無く、
存在を偽装しない。stagingとproductionのQueue/DLQを別々に作成し、producer
binding、consumer、secretを設定してrehearsalを完了した後だけexplicit enable
する。

## 8. API

| Method/path | 用途 |
|---|---|
| `POST /v1/signals/cms` | signed CMS ops signal |
| `POST /compat/v1/gate` | current CMS single-endpoint signal alias |
| `POST /v1/maintenance-requests` | signed expiring maintenance freeze request |
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

- D1: sites、checks、observations、receipts、component verdicts、
  deployment runtime identities、post-deploy requests/receipts、incidents、
  timeline、notification outbox、maintenance requests/receipts/freeze
  links、freezes、jobs、outbox/inbox、audit
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
各component/gate/panelは見出しとの明示的なARIA関連を持ち、statusは可視textと
accessible nameを併用する。skip link、44px以上の操作target、明示focus ring、
reduced-motionを提供する。desktop sidebarを隠す幅では同じanchor順のmobile
navigationを出し、`REMOTE NOT RUN`やfreshnessを小画面でも非表示にしない。

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
- Sites saved versionのcommit/version/archive digestはGuard自身のidentityであり、
  CMS runtime identityへ流用しない。CMS deployごとの動的identityをSites
  environmentへ書くとGuard再deployとの循環になるため、stableなprobe設定だけを
  Sitesへ置き、観測identityはD1で更新する。
- stagingでfailure matrixとnotification rehearsal後にproduction shadowへ進む。
- production gateは14日以上のshadow evidenceとowner承認後に有効化する。
- checked-in Worker configは`* * * * *` Cron、`nodejs_compat`、environment別
  D1 bindingを持つ。build artifactのtriggerをrelease contractで検査し、
  remoteで実発火とheartbeat freshnessを確認するまでCronをPASS扱いしない。
- notification Queue/DLQ/providerはproduction/stagingで分離し、
  `NOTIFICATION_QUEUE`、`NOTIFICATION_QUEUE_NAME`、provider 3変数を設定する。
  generated Sites packageにQueue bindingが無い間はoutboxをpendingに保ち、
  remote resourceをready/PASSと表示しない。

## 12. 既存CMSとの不整合と方針

CMSの`src/contracts/v1.ts`はsingle gate/ISO時刻、実consumerの
`worker/growth/operational-gate.ts`はgate map/epoch秒/freeze/HMACである。
MVPは実consumer contractを`OperationalGateCompatV1`として固定し、
canonical APIと混在させない。consumer-driven testをrelease blockerとする。

CMS ops envelope v1にはsiteId/audience/nonce/expiryがない。MVPはcredential
bindingとfreshness/dedupeでfail-closed補完し、v2 migrationを別Issueで行う。

現CMS post-deploy scriptの`site-<SHA先頭12文字>`は実Worker versionではない。
Cloudflareが返す実version IDを取得してrequestへ渡すまでは、server-owned
identityと一致せず`unknown`になる。

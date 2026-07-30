# CloudFlare-Guard 要件定義書

最終更新: 2026-07-31

## 1. 目的

DFConnectのマーケティング特化オウンドメディアについて、配信、編集、
問い合わせ、画像、通知、デプロイ、復旧準備、監視基盤自身をcomponent別に
可視化し、障害を鮮度付き証跡から検知・通知する。

Guardは公開経路の外に置く。Guard停止時も公開済みstatic siteは配信し続け、
新しいmerge、publish、deployだけをfail-closedで停止する。

## 2. 利用者

| Actor | 許可 |
|---|---|
| viewer/operator | Access内で状態、incident、sanitized evidenceを閲覧 |
| trusted CMS service | signed signal送信、gate取得、post-deploy判定要求 |
| notification worker | sanitized alert配送とreceipt記録 |
| AI observer | sanitized read APIのみ |
| AI proposer | 復旧案のdraftのみ |

AIはincident resolve、freeze解除、override、rollback、restore、Cloudflare
writeを実行できない。

## 3. 対象範囲

### 3.1 Component

1. `public_delivery`: HTTP、DNS、TLS、canonical、redirect、asset、header
2. `editorial`: `/admin/` shell、auth negative contract、repository/CI
3. `contact_intake`: Worker、Turnstile、rate limit、D1 write、Queue enqueue
4. `media_delivery`: manifest、private R2、image transform、known fixture
5. `notification_delivery`: Queue、consumer、provider 2xx marker、DLQ
6. `deployment_integrity`: exact SHA、Worker version、route、binding、migration
7. `recovery_readiness`: prior version、bookmark、rehearsal freshness
8. `autoguard_control_plane`: scheduler、D1、Queue、R2、alert heartbeat

### 3.2 Operation gate

- `contentPublish`
- `siteDeploy`
- `contactAccept`
- `destructiveRecovery`

Gateは`allow | deny`だけを返す。required componentが
`degraded | unhealthy | unknown | maintenance`、required signalが
missing/stale/invalid、またはactive freezeがある場合はdenyとする。

## 4. 機能要件

### GRD-F-001 Signal受付

- 現行CMSの`autoguard-ops-signal-envelope-v1`を互換受付する。
- Bearer credentialをserver側でsite/environmentへ固定する。
- stable JSON HMAC-SHA256、sentAt、environment、strict fieldを検証する。
- signalをsanitized append-only Observationへ変換する。

### GRD-F-002 Observationと鮮度

- statusは`pass | fail | degraded | unknown | unsupported`を区別する。
- effective `validUntil`はserver policyから算出する。
- last healthyは履歴にだけ使い、現在値へ延命しない。
- timeout、403、429、5xx、schema driftは`unknown`とする。

### GRD-F-003 外形監視

- review済みmanifestからのみtargetを生成する。
- apex、www、critical route、404、sitemap、robots、known assetを確認する。
- status、body marker/digest、content type、canonical、redirect、主要header、
  latencyを検査する。
- DNSとTLSを独立Observationにする。
- productionは2地点以上、うち1地点以上をCloudflare外に置く。
- Guard Workerは1分ごとのscheduled handlerからchecked-in production
  manifestだけを最大4並列で観測し、同じscheduled timeを冪等保存する。
- Workers `fetch`が直接返さない接続先IP、TLS証明書、protocolを推測・固定値で
  補完しない。明確なHTTP/security不一致は`fail`、timeout、403、429、5xx、
  証明不足は`unknown`とする。
- 全target ObservationのD1保存完了後だけscheduler heartbeatを`pass`にする。
  設定・adapter・D1障害ではpass heartbeatを残さず、D1 binding自体の欠損は
  handler failureとheartbeat欠落を独立monitorで検知する。

### GRD-F-004 CMS/Cloudflare監視

- `/healthz`はdeployment identityとしてのみ扱う。
- D1/R2/Queue/Tail/Turnstile/Workers/DNS/GitHubを別checkにする。
- provider APIをread-only tokenで確認する。
- desired configの存在だけでremote resourceをPASSにしない。

### GRD-F-005 VerdictとIncident

- component verdictは
  `healthy | degraded | unhealthy | unknown | maintenance`とする。
- 同じsite/environment/component/reason/scopeをfingerprintで1 incidentへ
  集約する。
- stateは
  `open -> acknowledged -> mitigating -> monitoring -> resolved`または
  `manual_required`とする。
- SEV-1/2は1回の成功で自動resolveしない。

### GRD-F-006 通知

- CMS contact通知と別Queue/DLQ/credentialを使う。
- schedulerは自身のsite/environmentに属する`pending` outboxだけを、1回最大
  10件、作成順で選ぶ。Queue bindingが無い場合はscanも状態変更もせず、
  public probeとPASS heartbeatを壊さない。
- canonical payload/digest/scopeを再検証し、破損rowは固定された安全なreasonで
  `blocked`にする。QueueへのJSON object送信完了後だけ、選択時snapshotと
  pending不変条件を比較するCASで`enqueued`へ進める。send/CAS失敗は
  `pending`に残す。
- consumerはWorkerに固定したsite/environment、期待Queue名、およびlocal D1
  outboxのincident、source Observation、canonical body/digest、pending/enqueued
  状態が完全一致するmessageだけをproviderへ渡す。fabricated、別scope、
  payload差替え、別Queueはprovider/marker/ACKへ進めない。
- providerは明示enable、環境変数だけのreview済みHTTPS endpointとsecretを
  必須とし、userinfo/query/fragment/CRLF/IP/localhost/非default portを拒否する。
  canonical JSONを5秒timeout、manual redirect、no-storeでPOSTし、response
  bodyを読取・保存・logしない。
- provider 2xx後だけ`http_2xx` delivery markerをD1へ保存し、その保存後だけ
  Queue messageをACKする。既存markerはincident/digestが一致するときだけ
  restart-safeな成功としてACKする。
- 429/5xx/timeoutはbounded retryし、numeric Retry-Afterだけを最大300秒で採用
  する。3xx、その他4xx、invalid response、scope/outbox/idempotency conflictは
  poison retryとして上限後DLQへ送る。
- DB、scope、Queue名、provider設定のいずれかが欠けるbatchはproviderを呼ばず
  batch全体を明示retryする。
- 通知経路停止は独立したout-of-band monitorで検知する。

### GRD-F-007 API

- canonical operability、gate evaluation、incident、post-deploy endpointを持つ。
- request/responseはversion、siteId、environment、correlation/idempotency IDを持つ。
- site/environment scope、body/rate limit、strict content typeを強制する。
- AI projectionはsanitized summaryだけを返す。

### GRD-F-008 CMS互換Gate

現行consumer向けに次の互換projectionを提供する。

```json
{
  "siteId": "dfconnect",
  "environment": "production",
  "gates": {
    "contentPublish": "allow",
    "siteDeploy": "allow"
  },
  "checkedAt": 1785427200,
  "freshUntil": 1785427380,
  "freeze": false,
  "signature": "hmac-sha256:..."
}
```

互換v1へ新fieldを暗黙追加せず、詳細component、blocked reason、incident IDは
canonical APIへ分離する。

### GRD-F-009 Post-deploy

- exact 40-character SHA、Worker version、environment、requestId、
  evidence digestを検証する。
- 5分以内に`pass | fail | unknown`を返す。
- duplicate requestでcheck/incident/receiptを増殖させない。
- `unknown`はfreeze/investigationだけを作り、rollback requestを作らない。
- Guard自身はrollbackを実行しない。

### GRD-F-010 運用Console

- Overview、8 component、4 gate、freshness、incident、notification、
  deploy、Guard readinessを表示する。
- stale/unknownをhealthyに見せない。
- 色だけに依存せず状態ラベルとreasonを表示する。
- MVPはread-onlyとし、危険操作UIとaudit削除UIを置かない。

### GRD-F-011 メンテナンス停止

- 現行CMSの署名済み`maintenance-request-v1`を専用endpointで受付する。
- site/environment、依頼時刻、最大15分の期限をserver policyで検証する。
- request、期限付きfreeze、署名receipt、auditを原子的かつ冪等に保存する。
- active freeze中はCMS互換Gateをdenyし、期限ちょうどで自然失効させる。
- 期限切れfreezeは監査履歴として保持し、Gateの有効行読取上限へ含めない。
- このendpointはactivate-onlyとし、AI用または無認証の解除・延長・overrideを
  提供しない。

### GRD-F-012 FAIL Incident化と通知outbox

- 永続化済みObservationのうち、statusが厳密に`fail`のrecordだけをIncident化
  する。`pass | degraded | unknown | unsupported`およびmaintenance状態からは
  Incident、timeline、通知outboxを作らない。
- severityは受信値を信用せず、version管理されたserver policyから決定する。
  自動判定でSEV-1を作らず、productionの公開・受付・通知・deploy・control
  plane failureはSEV-2、その他とstagingはSEV-3を初期値とする。
- Incident、Observation timeline、sanitizedな`pending`通知outboxをD1の単一
  batchで保存する。途中失敗では3者をrollbackし、Observationを再試行可能な
  状態で残す。
- 同じObservationの再処理は増殖させない。同じfingerprintの新しいFAILは
  timelineだけを追加し、`incident_opened`通知はIncidentごとに1件とする。
- CMS accepted/duplicateとscheduled public observationの両方でreconcileする。
  CMS reconcile失敗はgeneric `503`、scheduled失敗はcycle incompleteとして
  PASS heartbeatを残さない。
- schedulerは自身のsite/environmentに限り、Incident/timeline/outboxが欠けた
  永続FAILを索引付きscanで1 cycle最大32件までrepairする。別scopeのrecordは
  共有・誤binding時にも変更しない。Queue enqueue、provider呼出、delivery
  状態更新は別Issueとする。
- resolved Incidentと同じfingerprintの新しいFAILは、episode/reopen policyが
  定義されるまで新規通知を作らずfail-closedにする。migration前に解決済みの
  opening evidenceは遅延通知せず`blocked` outboxとして収束させる。

## 5. 非機能・セキュリティ要件

- contact name/email/body/IP、Cookie、Authorization、Turnstile token、
  webhook、API token、raw query、raw provider responseを保存・通知しない。
- sanitizerはallowlist-firstとし、失敗時はrawを破棄してunknownにする。
- URLはHTTPS、review済みhost/pathだけを許可し、credential URL、
  loopback、private/link-local/metadata address、off-origin redirectを拒否する。
- production/stagingのresource、token、audience、incident、evidenceを共有しない。
- normal Observationは90日、resolved incidentは365日を初期保持値とする。
- critical public failureの目標MTTDは3分、post-deploy判定は5分以内とする。
- structured logへcorrelation IDを持たせ、secret/PIIを出さない。
- 通知outboxへは`safe-notification-envelope-v1`のcanonical JSONとdigestだけを
  保存し、raw signal、受信severity、provider payloadを保存しない。
- Queueへstring化済みraw bodyではなく検証済みenvelope objectをJSON content
  typeで渡す。provider token、endpoint query、response body、例外本文を
  D1、Queue payload、結果object、structured logへ出さない。

## 6. 明示的な対象外

- GA4/GSC、広告、CRM、PV/CVR、revenue、keyword分析
- 記事企画、本文生成、本文正本、直接merge
- public status SaaS、tenant signup、billing
- WordPress runtime/restore
- DNS/WAF変更、D1 restore、R2 delete、secret rotationの自動実行
- AIによるunfreeze、override、rollback、restore

## 7. 受入と証跡

各Issueで次を分けて記録する。

- `LOCAL`: unit/property/security/build
- `STAGING_REMOTE`: resource inventory、failure injection、Queue/provider
- `PRODUCTION_REMOTE`: read-only observation、独立probe、shadow運用

remote未実施は`NOT_RUN`または`BLOCKED`とし、`PASS`にしない。

## 8. 外部blocker

- Cloudflare account/zone、production/staging resource owner
- Access audienceとservice identity
- 外部probe provider/region/credential/費用上限
- on-call、SEV、通知先、ack/escalation
- retention/legal hold owner
- production/staging D1/R2/Queue/DLQ実ID
- CloudFlare-CMS endpoint/secretの本番設定

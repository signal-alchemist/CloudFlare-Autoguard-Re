# Issue #24 evidence

## Scope

D1のlatest Observationをdeployment固定policyでcomponent Verdictへ
materializeし、期限付きactive freezeと共にGate/post-deployへ供給するlive
operational state。

## RED

- Command: `node --test tests/unit/live-operational-state.test.ts`
- Exit: `1`
- Expected failure:
  `config/sites/dfconnect.operational-policy.ts` が存在せず
  `ERR_MODULE_NOT_FOUND`。
- 実SQLite、scope、freshness、conflict、freeze、fail-closedの期待を実装前に
  testへ固定した。

## GREEN

- Command: `node --test tests/unit/live-operational-state.test.ts`
- Exit: `0`
- Result: 1 test passed。
- Command: `npm run test:unit`
- Exit: `0`
- Result: 18 tests passed。
- Command: `npm run validate`
- Exit: `0`
- Result: lint、typecheck、18 unit tests、production build passed。
- Command: `npm run test:rendered`
- Exit: `0`
- Result: 3 rendered Worker/HTML tests passed。
- Command: `npm run test:release`
- Exit: `0`
- Result: release archive contract passed with migrations `0000`–`0004`。

## LOCAL

- site/environment/component/check/source allowlist外の新しいrowを不採用: PASS
- latest同時刻のpass/fail conflictを`unknown`としてGate deny: PASS
- required Observationのmissing、stale、futureを`unknown`としてGate deny:
  PASS
- matching D1 rowのunknown schema/statusをhealthyにせずGate deny: PASS
- freshUntil超過後に旧healthyを延命せずunknownへ再materialize: PASS
- Verdictのscope、policy version、reason/Observation ID traceをD1へ保存:
  PASS
- staging/別siteのObservationとfreezeがproductionへ越境しない: PASS
- canonicalな未release freezeだけが
  `activatedAt <= now < expiresAt` の間active: PASS
- 期限切れfreezeをinactive、破損未release freezeをGate deny: PASS
- D1 close/read/write失敗を過去値へfallbackせずGate deny: PASS
- latest Observationは4096件、未release freezeは1024件を上限とし、超過時deny:
  PASS
- migrationの再適用安全性: PASS
- `npm run lint`: PASS
- `npm run typecheck`: PASS
- `npm run build`: PASS
- rendered console/Worker security contract: PASS
- release package migration completeness: PASS

## STAGING_REMOTE

`NOT_RUN` — staging D1 migration、Observation、freeze、Gateのremote確認は未実施。

## PRODUCTION_REMOTE

`NOT_RUN` — production D1 migrationとlive Gateは未deploy。checked-in production
policyはpublic delivery 9 checkで`public_probe`と`external_probe`の両方を要求
するため、外部probe未設定時は意図どおりunknown/denyとなる。

## Rollback / rehearsal

Issue #24の単一commitをrevertする。migrationはappend-only table/index追加で、
既存Observation、incident、notification、post-deploy recordを変更しない。
remote migration rollbackは未rehearsal。

## Unresolved blockers

- production/staging D1へのmigration適用はresource owner作業。
- approved external probe Observationが未供給のためpublic deliveryはhealthyに
  昇格しない。
- editorial、contact、media、notification、deployment、recovery、Guard
  control-planeのpositive policy/producerは未実装で、required component
  missingによりGateはdenyを維持する。
- CMS ops signalはfailure-onlyであり、absenceをhealthへ昇格する用途には
  使用しない。positive probeへのnegative overrideは別運用設計が必要。

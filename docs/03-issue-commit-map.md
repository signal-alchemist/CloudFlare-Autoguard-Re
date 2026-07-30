# Issue / commit map

全IssueはOPENのまま運用する。子IssueごとにRed -> Greenを実施し、実装commitを
ちょうど1件作る。commit messageは`Refs #N`を使う。

| Feature parent | Child test Issues |
|---|---|
| #1 Signal / Observation | #6 contract、#7 security、#10 durability |
| #4 Component / Verdict | #9 public delivery、#14 CMS components、#17 freshness |
| #5 Incident / Notification | #8 state machine、#12 delivery、#13 privacy |
| #3 Gate / Post-deploy | #11 gate contract、#18 post-deploy、#19 fail-closed |
| #2 Read-only console | #20 rendering、#15 security/UI、#16 accessibility/remote、#21 private release |
| #22 Runtime orchestration | #23 signed CMS signal HTTP ingress、#24 D1 live operational state、#25 post-deploy runtime identity、#26 scheduled public-delivery producer、#27 maintenance request / expiring freeze、#28 FAIL incident / notification outbox reconciliation、#29 scoped Queue dispatch / consumer / reviewed HTTP provider |

GitHub子Issue #29は親Issue #22へ紐付け済みで、OPENのまま維持する。#29内の
受入観点を次のtest cardとして`docs/evidence/issue-29.md`へ集約し、local testと
remote evidenceを混同しない。

| Acceptance test card | Test perspective |
|---|---|
| #29-T01 | scoped pending scan、max 10、JSON Queue送信後CAS |
| #29-T02 | Queue欠損/send/CAS失敗時のpending保持とscheduler分離 |
| #29-T03 | canonical/digest/scope破損のsafe blocked収束 |
| #29-T04 | reviewed HTTPS provider、timeout、redirect、secret/response非露出 |
| #29-T05 | exact local outbox/Incident/Observation consumer authorization |
| #29-T06 | 2xx marker then ACK、restart dedupe、status別retry/poison |
| #29-T07 | missing runtime dependencyとwrong Queueのbatch retry |
| #29-T08 | generated binding不在、remote NOT_RUN、migration不変のrelease契約 |

Evidence file naming:

```text
docs/evidence/issue-<number>.md
```

各fileは以下を分ける。

- RED: 先に失敗したtestと理由
- GREEN: 同じtestの成功
- LOCAL
- STAGING_REMOTE
- PRODUCTION_REMOTE
- rollback/rehearsal
- unresolved blocker

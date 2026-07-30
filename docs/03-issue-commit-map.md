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
| #22 Runtime orchestration | #23 signed CMS signal HTTP ingress、#24 D1 live operational state、#25 post-deploy runtime identity |

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

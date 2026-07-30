"use client";

import { useMemo } from "react";
import type { DashboardSnapshot } from "../lib/ui/dashboard-model";
import { resolveConsoleReason } from "../lib/ui/console-copy";

interface GuardConsoleProps {
  snapshot: DashboardSnapshot;
  productName: string;
}

const navigation = [
  ["overview", "Overview"],
  ["components", "Components"],
  ["incidents", "Incidents"],
  ["deployments", "Deployments"],
] as const;

function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <span />
      <span />
      <span />
      <span />
    </span>
  );
}

function StatusBadge({
  status,
  compact = false,
}: {
  status: string;
  compact?: boolean;
}) {
  const tone = status.toLowerCase().replaceAll("_", "-");
  return (
    <span className={`status-badge status-${tone}`} data-compact={compact}>
      <span className="status-dot" aria-hidden="true" />
      {status.replaceAll("_", " ")}
    </span>
  );
}

function SectionHeading({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <header className="section-heading">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h2>{title}</h2>
      </div>
      <p>{description}</p>
    </header>
  );
}

export function GuardConsole({
  snapshot,
  productName,
}: GuardConsoleProps) {
  const environment = snapshot.environment;
  const componentCounts = useMemo(
    () =>
      snapshot.components.reduce<Record<string, number>>((counts, item) => {
        counts[item.state] = (counts[item.state] ?? 0) + 1;
        return counts;
      }, {}),
    [snapshot],
  );

  return (
    <div
      className="guard-app"
      data-app="cloudflare-guard"
      data-environment={environment}
    >
      <a className="skip-link" href="#main-content">
        メインコンテンツへ
      </a>

      <aside className="sidebar" aria-label="メインナビゲーション">
        <div className="sidebar-brand">
          <BrandMark />
          <div>
            <strong>{productName}</strong>
            <span>OPERATIONS CONTROL</span>
          </div>
        </div>

        <nav>
          <p className="nav-label">Monitor</p>
          <ul>
            {navigation.map(([id, label], index) => (
              <li key={id}>
                <a href={`#${id}`} aria-current={index === 0 ? "page" : undefined}>
                  <span className="nav-index" aria-hidden="true">
                    0{index + 1}
                  </span>
                  {label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="sidebar-foot">
          <span className="read-only-lock" aria-hidden="true">
            ◈
          </span>
          <div>
            <strong>READ-ONLY</strong>
            <span>危険操作はこの画面にありません</span>
          </div>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div className="mobile-brand">
            <BrandMark />
            <strong>{productName}</strong>
          </div>
          <div className="environment-switch" aria-label="サーバー固定の表示環境">
            <span>
              {environment === "production" ? "Production" : "Staging"}
            </span>
            <small>server scoped</small>
          </div>
          <div className="topbar-actions">
            <span className="remote-chip">
              <span aria-hidden="true">●</span> REMOTE NOT RUN
            </span>
            <button
              className="refresh-button"
              type="button"
              onClick={() => window.location.reload()}
            >
              <span aria-hidden="true">↻</span>
              再読み込み
            </button>
          </div>
        </header>

        <main id="main-content">
          <section className="hero" id="overview" aria-labelledby="page-title">
            <div className="hero-copy">
              <p className="eyebrow">
                DFC / {environment.toUpperCase()} / CONTROL PLANE
              </p>
              <h1 id="page-title">運用ステータス</h1>
              <p>
                公開サイトからデプロイ、通知経路までをひとつの判断面に。
                不明な状態は正常に見せず、運用開始前の不足をそのまま表示します。
              </p>
            </div>
            <div className="hero-state" role="status" aria-live="polite">
              <span className="hero-state-label">CURRENT OPERABILITY</span>
              <strong>{snapshot.operability}</strong>
              <span>{snapshot.operabilityLabel}</span>
            </div>
          </section>

          <section className="truth-banner" aria-label="リモート検証状況">
            <div className="truth-icon" aria-hidden="true">
              !
            </div>
            <div>
              <strong>最新のリモート証跡は未取得</strong>
              <p>
                ローカル実装は検証済みですが、Cloudflare資源・外部probe・通知先は
                NOT RUNです。すべてのGateは安全側でDENYを維持します。
              </p>
            </div>
            <span>{snapshot.evidenceMode}</span>
          </section>

          <section className="metric-grid" aria-label="概要指標">
            <article className="metric-card metric-primary">
              <p>Required components</p>
              <div className="metric-value">
                <strong>{snapshot.components.length}</strong>
                <span>/ 08</span>
              </div>
              <small>
                {componentCounts.UNKNOWN ?? 0} unknown ·{" "}
                {componentCounts.DEGRADED ?? 0} degraded
              </small>
            </article>
            <article className="metric-card">
              <p>Operation gates</p>
              <div className="metric-value">
                <strong>
                  {snapshot.gates.filter((gate) => gate.decision === "DENY").length}
                </strong>
                <span>DENY</span>
              </div>
              <small>missing/stale/unknownはfail-closed</small>
            </article>
            <article className="metric-card">
              <p>Active incidents</p>
              <div className="metric-value">
                <strong>{snapshot.incidents.active}</strong>
                <span>REMOTE</span>
              </div>
              <small>未取得のため0件とは判定しません</small>
            </article>
            <article className="metric-card">
              <p>Local verification</p>
              <div className="metric-value">
                <strong>{snapshot.localVerification.tests}</strong>
                <span>TESTS</span>
              </div>
              <small>typecheck · lint · build / LOCAL PASS</small>
            </article>
          </section>

          <section
            className="content-section"
            id="components"
            aria-labelledby="components-title"
          >
            <SectionHeading
              eyebrow="01 / OPERABILITY"
              title="8 Components"
              description="CMSとGuardの責務を混ぜず、現在値・鮮度・証跡をコンポーネント単位で確認します。"
            />
            <div className="component-grid" id="components-title">
              {snapshot.components.map((component, index) => (
                <article
                  className="component-card"
                  data-component={component.id}
                  key={component.id}
                >
                  <div className="component-card-top">
                    <span className="component-number">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <StatusBadge status={component.state} compact />
                  </div>
                  <div className="component-title">
                    <span className="component-symbol" aria-hidden="true">
                      {component.symbol}
                    </span>
                    <div>
                      <h3>{component.label}</h3>
                      <code>{component.id}</code>
                    </div>
                  </div>
                  <p>{component.summary}</p>
                  <dl>
                    <div>
                      <dt>Freshness</dt>
                      <dd>{component.freshness}</dd>
                    </div>
                    <div>
                      <dt>Evidence</dt>
                      <dd>{component.evidence}</dd>
                    </div>
                  </dl>
                  <details>
                    <summary>判定理由</summary>
                    <p>{resolveConsoleReason(component.reasonCode)}</p>
                  </details>
                </article>
              ))}
            </div>
          </section>

          <section className="content-section gate-section" aria-labelledby="gates-title">
            <SectionHeading
              eyebrow="02 / DECISION"
              title="4 Operation Gates"
              description="required componentがひとつでもmissing・stale・非healthyなら、操作は許可しません。"
            />
            <div className="gate-table" id="gates-title">
              <div className="gate-table-head" aria-hidden="true">
                <span>Operation</span>
                <span>Required component</span>
                <span>Decision</span>
                <span>Freshness</span>
              </div>
              {snapshot.gates.map((gate) => (
                <article className="gate-row" data-gate={gate.id} key={gate.id}>
                  <div>
                    <span className="gate-icon" aria-hidden="true">
                      {gate.symbol}
                    </span>
                    <div>
                      <h3>{gate.label}</h3>
                      <code>{gate.id}</code>
                    </div>
                  </div>
                  <p>{gate.required.join(" · ")}</p>
                  <StatusBadge status={gate.decision} compact />
                  <span className="freshness-value">{gate.freshness}</span>
                </article>
              ))}
            </div>
          </section>

          <section className="split-section" id="incidents">
            <article className="panel incident-panel">
              <div className="panel-head">
                <div>
                  <p className="eyebrow">03 / RESPONSE</p>
                  <h2>インシデント</h2>
                </div>
                <StatusBadge status="REMOTE_NOT_RUN" compact />
              </div>
              <div className="empty-state">
                <span aria-hidden="true">◎</span>
                <h3>リモートIncidentは未取得</h3>
                <p>
                  「0件」ではありません。D1本番bindingとshadow運用開始後に
                  open / monitoring / manual_required を表示します。
                </p>
              </div>
              <div className="mini-timeline" aria-label="Incident状態遷移">
                {["open", "acknowledged", "mitigating", "monitoring", "resolved"].map(
                  (state, index) => (
                    <span key={state}>
                      <i aria-hidden="true">{index + 1}</i>
                      {state}
                    </span>
                  ),
                )}
              </div>
            </article>

            <article className="panel route-panel">
              <div className="panel-head">
                <div>
                  <p className="eyebrow">04 / DELIVERY</p>
                  <h2>通知経路</h2>
                </div>
                <StatusBadge status={snapshot.notification.state} compact />
              </div>
              <div className="route-flow" aria-label="通知配送フロー">
                {snapshot.notification.steps.map((step, index) => (
                  <div key={step.label}>
                    <span className="route-step-icon" aria-hidden="true">
                      {index + 1}
                    </span>
                    <div>
                      <strong>{step.label}</strong>
                      <small>{step.detail}</small>
                    </div>
                    <StatusBadge status={step.state} compact />
                  </div>
                ))}
              </div>
              <p className="panel-note">{snapshot.notification.note}</p>
            </article>
          </section>

          <section className="split-section" id="deployments">
            <article className="panel deploy-panel">
              <div className="panel-head">
                <div>
                  <p className="eyebrow">05 / RELEASE</p>
                  <h2>デプロイ検証</h2>
                </div>
                <StatusBadge status={snapshot.deploy.state} compact />
              </div>
              <dl className="deploy-facts">
                <div>
                  <dt>Commit SHA</dt>
                  <dd>{snapshot.deploy.commitSha}</dd>
                </div>
                <div>
                  <dt>Worker version</dt>
                  <dd>{snapshot.deploy.workerVersion}</dd>
                </div>
                <div>
                  <dt>Post-deploy receipt</dt>
                  <dd>{snapshot.deploy.receipt}</dd>
                </div>
              </dl>
              <p className="panel-note">{snapshot.deploy.note}</p>
            </article>

            <article className="panel readiness-panel">
              <div className="panel-head">
                <div>
                  <p className="eyebrow">06 / SELF CHECK</p>
                  <h2>Guard readiness</h2>
                </div>
                <StatusBadge status={snapshot.readiness.state} compact />
              </div>
              <ul className="readiness-list">
                {snapshot.readiness.items.map((item) => (
                  <li key={item.label}>
                    <span aria-hidden="true">{item.local ? "✓" : "–"}</span>
                    <div>
                      <strong>{item.label}</strong>
                      <small>{item.detail}</small>
                    </div>
                    <b>{item.local ? "LOCAL PASS" : "NOT RUN"}</b>
                  </li>
                ))}
              </ul>
            </article>
          </section>

          <footer className="console-footer">
            <div>
              <BrandMark />
              <span>CloudFlare Guard / DFConnect Operations</span>
            </div>
            <p>
              Data mode: {snapshot.evidenceMode} · Updated:{" "}
              {snapshot.displayUpdatedAt}
            </p>
          </footer>
        </main>
      </div>
    </div>
  );
}

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
  ["gates", "Gates"],
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
    <span
      className={`status-badge status-${tone}`}
      data-compact={compact}
      aria-label={`状態: ${status.replaceAll("_", " ")}`}
    >
      <span className="status-dot" aria-hidden="true" />
      {status.replaceAll("_", " ")}
    </span>
  );
}

function SectionHeading({
  id,
  eyebrow,
  title,
  description,
}: {
  id: string;
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <header className="section-heading">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h2 id={id}>{title}</h2>
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

        <nav aria-label="デスクトップナビゲーション">
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
            <span
              className="remote-chip"
              data-live={snapshot.dataAvailability === "LIVE"}
              aria-label={`リモート証跡: ${snapshot.evidenceMode}`}
            >
              <span aria-hidden="true">●</span> {snapshot.evidenceMode}
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

        <nav className="mobile-nav" aria-label="モバイルナビゲーション">
          <ul>
            {navigation.map(([id, label]) => (
              <li key={id}>
                <a href={`#${id}`}>{label}</a>
              </li>
            ))}
          </ul>
        </nav>

        <main id="main-content" tabIndex={-1}>
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
            <div
              className="hero-state"
              data-state={snapshot.operability.toLowerCase()}
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              <span className="hero-state-label">CURRENT OPERABILITY</span>
              <strong>{snapshot.operability}</strong>
              <span>{snapshot.operabilityLabel}</span>
            </div>
          </section>

          <section
            className="truth-banner"
            data-live={snapshot.dataAvailability === "LIVE"}
            aria-label="リモート検証状況"
          >
            <div className="truth-icon" aria-hidden="true">
              {snapshot.dataAvailability === "LIVE" ? "✓" : "!"}
            </div>
            <div>
              <strong>{snapshot.truth.title}</strong>
              <p>{snapshot.truth.detail}</p>
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
                {componentCounts.HEALTHY ?? 0} healthy ·{" "}
                {componentCounts.UNKNOWN ?? 0} unknown ·{" "}
                {componentCounts.UNHEALTHY ?? 0} unhealthy
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
                <strong>{snapshot.incidents.active ?? "—"}</strong>
                <span>
                  {snapshot.incidents.available ? "ACTIVE" : "UNKNOWN"}
                </span>
              </div>
              <small>
                {snapshot.incidents.available
                  ? snapshot.incidents.truncated
                    ? "表示上限を超えています"
                    : "D1 read succeeded"
                  : "未取得を0件として扱いません"}
              </small>
            </article>
            <article className="metric-card">
              <p>Scheduler heartbeat</p>
              <div className="metric-value">
                <strong>{snapshot.scheduler.displayState}</strong>
                <span>HEARTBEAT</span>
              </div>
              <small>{snapshot.scheduler.detail}</small>
            </article>
          </section>

          <section
            className="content-section"
            id="components"
            aria-labelledby="components-title"
          >
            <SectionHeading
              id="components-title"
              eyebrow="01 / OPERABILITY"
              title="8 Components"
              description="CMSとGuardの責務を混ぜず、現在値・鮮度・証跡をコンポーネント単位で確認します。"
            />
            <div className="component-grid">
              {snapshot.components.map((component, index) => (
                <article
                  className="component-card"
                  data-component={component.id}
                  key={component.id}
                  aria-labelledby={`component-title-${component.id}`}
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
                      <h3 id={`component-title-${component.id}`}>
                        {component.label}
                      </h3>
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
                    <div>
                      <dt>Active Incident</dt>
                      <dd>{component.activeIncidentCount ?? "—"}</dd>
                    </div>
                  </dl>
                  <details>
                    <summary>判定理由</summary>
                    <p>
                      {resolveConsoleReason(
                        component.reasonCodes[0] ?? "component_reason_missing",
                      )}
                    </p>
                    <code className="reason-code-list">
                      {component.reasonCodes.join(" · ")}
                    </code>
                  </details>
                </article>
              ))}
            </div>
          </section>

          <section
            className="content-section gate-section"
            id="gates"
            aria-labelledby="gates-title"
          >
            <SectionHeading
              id="gates-title"
              eyebrow="02 / DECISION"
              title="4 Operation Gates"
              description="required componentがひとつでもmissing・stale・非healthyなら、操作は許可しません。"
            />
            <div className="gate-table">
              <div className="gate-table-head" aria-hidden="true">
                <span>Operation</span>
                <span>Required component</span>
                <span>Decision</span>
                <span>Freshness</span>
              </div>
              {snapshot.gates.map((gate) => (
                <article
                  className="gate-row"
                  data-gate={gate.id}
                  key={gate.id}
                  aria-labelledby={`gate-title-${gate.id}`}
                >
                  <div>
                    <span className="gate-icon" aria-hidden="true">
                      {gate.symbol}
                    </span>
                    <div>
                      <h3 id={`gate-title-${gate.id}`}>{gate.label}</h3>
                      <code>{gate.id}</code>
                    </div>
                  </div>
                  <div className="gate-dependencies">
                    <p>{gate.required.join(" · ")}</p>
                    <small>
                      {gate.reasonCodes.join(" · ")}
                    </small>
                  </div>
                  <StatusBadge status={gate.decision} compact />
                  <span className="freshness-value">{gate.freshness}</span>
                </article>
              ))}
            </div>
          </section>

          <section className="split-section" id="incidents">
            <article
              className="panel incident-panel"
              aria-labelledby="incidents-title"
            >
              <div className="panel-head">
                <div>
                  <p className="eyebrow">03 / RESPONSE</p>
                  <h2 id="incidents-title">インシデント</h2>
                </div>
                <StatusBadge
                  status={
                    snapshot.incidents.available
                      ? snapshot.incidents.active === 0
                        ? "OBSERVED"
                        : "ATTENTION"
                      : "REMOTE_NOT_RUN"
                  }
                  compact
                />
              </div>
              {snapshot.incidents.available &&
              snapshot.incidents.items.length > 0 ? (
                <ul className="incident-list">
                  {snapshot.incidents.items.map((incident) => (
                    <li key={incident.incidentId}>
                      <div>
                        <StatusBadge
                          status={incident.severity.toUpperCase()}
                          compact
                        />
                        <strong>{incident.component}</strong>
                      </div>
                      <code>{incident.incidentId}</code>
                      <p>{incident.reasonCode}</p>
                      <small>
                        {incident.state} · opened {incident.openedAt}
                      </small>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="empty-state">
                  <span aria-hidden="true">◎</span>
                  <h3>
                    {snapshot.incidents.available
                      ? "Active Incidentはありません"
                      : "リモートIncidentは未取得"}
                  </h3>
                  <p>
                    {snapshot.incidents.available
                      ? "D1のscope付き読取結果です。監視証跡の不足はcomponentのUNKNOWNとして別に表示します。"
                      : "「0件」ではありません。D1を取得できないため件数は不明です。"}
                  </p>
                </div>
              )}
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

            <article
              className="panel route-panel"
              aria-labelledby="notification-title"
            >
              <div className="panel-head">
                <div>
                  <p className="eyebrow">04 / DELIVERY</p>
                  <h2 id="notification-title">通知経路</h2>
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
            <article
              className="panel deploy-panel"
              aria-labelledby="deploy-title"
            >
              <div className="panel-head">
                <div>
                  <p className="eyebrow">05 / RELEASE</p>
                  <h2 id="deploy-title">デプロイ検証</h2>
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

            <article
              className="panel readiness-panel"
              aria-labelledby="readiness-title"
            >
              <div className="panel-head">
                <div>
                  <p className="eyebrow">06 / SELF CHECK</p>
                  <h2 id="readiness-title">Guard readiness</h2>
                </div>
                <StatusBadge status={snapshot.readiness.state} compact />
              </div>
              <ul className="readiness-list">
                {snapshot.readiness.items.map((item) => (
                  <li key={item.label}>
                    <span aria-hidden="true">
                      {item.state === "READY"
                        ? "✓"
                        : item.state === "NOT_READY"
                          ? "!"
                          : "–"}
                    </span>
                    <div>
                      <strong>{item.label}</strong>
                      <small>{item.detail}</small>
                    </div>
                    <b data-state={item.state}>
                      {item.state.replaceAll("_", " ")}
                    </b>
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

import type {
  CmsOpsSignal,
  Component,
  ObservationStatus,
} from "../contracts/ops-signal.ts";

export interface CmsSignalClassification {
  component: Component;
  status: Extract<ObservationStatus, "fail">;
  reasonCode: "worker_runtime_failure" | "contact_delivery_failed";
  checkId: "cms_ops.worker_runtime" | "cms_ops.contact_delivery";
  scope: string;
}

export function classifyCmsSignal(
  signal: CmsOpsSignal,
): CmsSignalClassification {
  if (signal.event === "contact.delivery_failure") {
    return {
      component: "notification_delivery",
      status: "fail",
      reasonCode: "contact_delivery_failed",
      checkId: "cms_ops.contact_delivery",
      scope: signal.service,
    };
  }

  const component: Component =
    signal.route === "/api/contact"
      ? "contact_intake"
      : signal.route === "/img/:width/:object-key"
        ? "media_delivery"
        : signal.route === "/healthz"
          ? "deployment_integrity"
          : "editorial";
  return {
    component,
    status: "fail",
    reasonCode: "worker_runtime_failure",
    checkId: "cms_ops.worker_runtime",
    scope: signal.route,
  };
}

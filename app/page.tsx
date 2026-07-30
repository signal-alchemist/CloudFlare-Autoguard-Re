import type { Metadata } from "next";
import { headers } from "next/headers";
import { GuardConsole } from "./GuardConsole";
import { dashboardSnapshots } from "../lib/ui/dashboard-model";

export const metadata: Metadata = {
  title: "CloudFlare Guard | DFConnect",
  description:
    "DFConnectの公開配信、CMS、問い合わせ、通知、デプロイを可視化するread-only運用コンソール。",
};

export default async function Home() {
  const requestHeaders = await headers();
  const requestedEnvironment = requestHeaders.get("x-guard-environment");
  const environment =
    requestedEnvironment === "staging" ? "staging" : "production";

  return (
    <GuardConsole
      snapshot={dashboardSnapshots[environment]}
      productName="CloudFlare Guard"
    />
  );
}

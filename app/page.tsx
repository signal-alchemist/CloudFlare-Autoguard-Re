import type { Metadata } from "next";
import { GuardConsole } from "./GuardConsole";
import { dashboardSnapshots } from "../lib/ui/dashboard-model";

export const metadata: Metadata = {
  title: "CloudFlare Guard | DFConnect",
  description:
    "DFConnectの公開配信、CMS、問い合わせ、通知、デプロイを可視化するread-only運用コンソール。",
};

export default function Home() {
  return (
    <GuardConsole
      snapshots={dashboardSnapshots}
      productName="CloudFlare Guard"
    />
  );
}

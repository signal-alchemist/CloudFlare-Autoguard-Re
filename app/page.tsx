import type { Metadata } from "next";
import { GuardConsole } from "./GuardConsole";
import { loadConsoleSnapshot } from "../lib/runtime/console-snapshot.server";

export const metadata: Metadata = {
  title: "CloudFlare Guard | DFConnect",
  description:
    "DFConnectの公開配信、CMS、問い合わせ、通知、デプロイを可視化するread-only運用コンソール。",
};

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function Home() {
  const snapshot = await loadConsoleSnapshot();

  return (
    <GuardConsole
      snapshot={snapshot}
      productName="CloudFlare Guard"
    />
  );
}

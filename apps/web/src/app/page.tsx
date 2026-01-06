"use client";

import dynamic from "next/dynamic";

// Disable SSR to avoid Radix UI hydration mismatches
const InvestigationApp = dynamic(
  () => import("@/components/investigation-app").then((mod) => mod.InvestigationApp),
  { ssr: false }
);

export default function Home() {
  return <InvestigationApp />;
}

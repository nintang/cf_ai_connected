"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { ArrowLeft, Network } from "lucide-react";
import { Button } from "@/components/ui/button";

// Disable SSR for Sigma.js (requires DOM)
const SocialGraph = dynamic(
  () => import("@/components/social-graph").then((mod) => mod.SocialGraph),
  { ssr: false }
);

export default function GraphPage() {
  return (
    <div className="h-screen flex flex-col bg-white">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 border-b border-zinc-200">
        <div className="flex items-center gap-4">
          <Link href="/">
            <Button variant="ghost" size="sm" className="gap-2">
              <ArrowLeft className="h-4 w-4" />
              Back to Search
            </Button>
          </Link>
          <div className="h-6 w-px bg-zinc-200" />
          <div className="flex items-center gap-2">
            <Network className="h-5 w-5 text-indigo-500" />
            <h1 className="text-lg font-semibold text-zinc-900">Social Graph</h1>
          </div>
        </div>
        <div className="text-sm text-zinc-500">
          Pan and zoom to explore connections
        </div>
      </header>

      {/* Graph */}
      <main className="flex-1 relative">
        <SocialGraph className="h-full" />
      </main>
    </div>
  );
}

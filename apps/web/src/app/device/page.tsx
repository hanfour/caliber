"use client";

import { Suspense } from "react";
import { DeviceApproval } from "@/components/device/DeviceApproval";

// Dashboard-OUTSIDE route: does not inherit the dashboard layout's server
// session gate. DeviceApproval does its own client-side session check
// (mirrors apps/web/src/app/api-keys/reveal/[token]/page.tsx).
export default function DevicePage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <Suspense>
        <DeviceApproval />
      </Suspense>
    </main>
  );
}

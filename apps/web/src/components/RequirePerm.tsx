"use client";

import type { ReactNode } from "react";
import type { Action } from "@caliber/auth/rbac/actions";
import { usePermissions } from "@/lib/usePermissions";

interface Props {
  action: Action;
  children: ReactNode;
  fallback?: ReactNode;
}

export function RequirePerm({ action, children, fallback = null }: Props) {
  const { can, isLoading } = usePermissions();
  if (isLoading) return null;
  if (!can(action)) return <>{fallback}</>;
  return <>{children}</>;
}

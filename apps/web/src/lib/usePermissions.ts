"use client";

import { useMemo } from "react";
import { can } from "@caliber/auth/rbac/check";
import type { Action } from "@caliber/auth/rbac/actions";
import { trpc } from "@/lib/trpc/client";
import { buildPermissionsFromSession } from "./permissions";

export function usePermissions() {
  const { data: session, isLoading } = trpc.me.session.useQuery(undefined, {
    staleTime: 60_000,
  });

  const perm = useMemo(() => {
    if (!session) return null;
    return buildPermissionsFromSession(session);
  }, [session]);

  const check = useMemo(
    () => (action: Action) => {
      if (!perm) return false;
      return can(perm, action);
    },
    [perm],
  );

  return { can: check, perm, session, isLoading };
}

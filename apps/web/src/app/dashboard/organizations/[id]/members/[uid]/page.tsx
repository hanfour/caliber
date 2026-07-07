"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, ShieldAlert } from "lucide-react";
import { trpc } from "@/lib/trpc/client";
import { Card } from "@/components/ui/card";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { RequirePerm } from "@/components/RequirePerm";
import { ReportDetail } from "@/components/evaluator/ReportDetail";

export default function MemberDetailPage() {
  const params = useParams();
  const identifier = params?.id as string;
  const uid = params?.uid as string;
  // Resolve slug-or-UUID → canonical org UUID (the report queries + RBAC checks
  // require a UUID; a raw slug 400s).
  const { data: org } = trpc.organizations.resolveIdentifier.useQuery(
    { identifier },
    { enabled: !!identifier },
  );
  const orgId = org?.id;

  if (!orgId) {
    return (
      <div className="mx-auto max-w-4xl p-6 text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <Link
        href={`/dashboard/organizations/${identifier}/members`}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to members
      </Link>

      <RequirePerm
        action={{ type: "report.read_user", orgId, targetUserId: uid }}
        fallback={
          <Card className="shadow-card flex flex-col items-center p-10 text-center">
            <ShieldAlert className="h-6 w-6 text-muted-foreground" />
            <h3 className="mt-3 text-sm font-semibold">
              You don&apos;t have access to this member&apos;s report
            </h3>
            <p className="mt-1 max-w-sm text-xs text-muted-foreground">
              Ask a workspace admin for the{" "}
              <code className="font-mono">report.read_user</code> permission.
            </p>
          </Card>
        }
      >
        <MemberDetailBody orgId={orgId} uid={uid} />
      </RequirePerm>
    </div>
  );
}

function MemberDetailBody({ orgId, uid }: { orgId: string; uid: string }) {
  const { data: user, isLoading } = trpc.users.get.useQuery({ id: uid });

  const userName = isLoading
    ? "…"
    : (user?.name ?? user?.email ?? "Member");

  const initials = userName !== "…"
    ? userName.charAt(0).toUpperCase()
    : "?";

  return (
    <div className="space-y-6">
      {/* Member header */}
      <div className="flex items-center gap-4">
        <Avatar className="h-12 w-12">
          <AvatarFallback className="bg-primary/10 text-sm font-semibold text-primary">
            {initials}
          </AvatarFallback>
        </Avatar>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{userName}</h1>
          {user?.email && (
            <p className="text-sm text-muted-foreground">{user.email}</p>
          )}
        </div>
      </div>

      {/* Evaluation section */}
      <ReportDetail orgId={orgId} userId={uid} userName={userName} />
    </div>
  );
}

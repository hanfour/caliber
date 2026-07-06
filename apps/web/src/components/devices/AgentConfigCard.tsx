"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { trpc } from "@/lib/trpc/client";
import { usePermissions } from "@/lib/usePermissions";
import { RequirePerm } from "@/components/RequirePerm";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const MIN_INTERVAL_SECONDS = 30;
const MAX_INTERVAL_SECONDS = 1800;

function AgentConfigForm({ orgId }: { orgId: string }) {
  const t = useTranslations("devices.agentConfig");
  const tCommon = useTranslations("common");
  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.devices.agentConfig.get.useQuery({ orgId });
  const [value, setValue] = useState<number | "">("");

  // Seed the input once the org's current poll interval loads. `data` is
  // refetched after a successful save (see onSuccess below), so this also
  // re-syncs the field if the server clamped the submitted value.
  useEffect(() => {
    if (data) setValue(data.pollIntervalSeconds);
  }, [data]);

  const save = trpc.devices.agentConfig.set.useMutation({
    onSuccess: (result, variables) => {
      setValue(result.pollIntervalSeconds);
      if (result.pollIntervalSeconds !== variables.pollIntervalSeconds) {
        toast.error(t("outOfRange"));
      } else {
        toast.success(t("saved"));
      }
      utils.devices.agentConfig.get.invalidate({ orgId });
    },
    onError: (e) => {
      const code = (e.data as { code?: string } | undefined)?.code;
      toast.error(code === "FORBIDDEN" ? tCommon("insufficientPermission") : e.message);
    },
  });

  const handleSave = () => {
    if (value === "") return;
    save.mutate({ orgId, pollIntervalSeconds: value });
  };

  return (
    <Card className="shadow-card">
      <CardHeader>
        <CardTitle className="text-sm font-medium">{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1.5">
        <Label htmlFor="agentPollIntervalSeconds">{t("intervalLabel")}</Label>
        <Input
          id="agentPollIntervalSeconds"
          type="number"
          min={MIN_INTERVAL_SECONDS}
          max={MAX_INTERVAL_SECONDS}
          value={value}
          disabled={isLoading}
          onChange={(e) =>
            setValue(e.target.value === "" ? "" : Number(e.target.value))
          }
        />
        <p className="text-xs text-muted-foreground">{t("intervalHint")}</p>
      </CardContent>
      <CardFooter className="flex justify-end">
        <Button onClick={handleSave} disabled={save.isPending || value === ""}>
          {t("save")}
        </Button>
      </CardFooter>
    </Card>
  );
}

export function AgentConfigCard() {
  const { session } = usePermissions();
  const orgId = session?.coveredOrgs?.[0];
  if (!orgId) return null;

  return (
    <RequirePerm action={{ type: "device.list_all", orgId }}>
      <AgentConfigForm orgId={orgId} />
    </RequirePerm>
  );
}

"use client";

import { useState } from "react";
import { Plus, FlaskConical, BookOpen, MoreHorizontal, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { useConfirm } from "@/components/ui/confirm-dialog";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@caliber/api-types";
import { trpc } from "@/lib/trpc/client";
import { usePermissions } from "@/lib/usePermissions";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { RubricEditor } from "./RubricEditor";
import { DryRunPreview } from "./DryRunPreview";

// ─── Types ────────────────────────────────────────────────────────────────────

type RubricRow = inferRouterOutputs<AppRouter>["rubrics"]["list"][number];

// ─── Row actions ─────────────────────────────────────────────────────────────

interface RowActionsProps {
  row: RubricRow;
  orgId: string;
  activeRubricId: string | null;
  onEdit: (row: RubricRow) => void;
  onDryRun: (row: RubricRow) => void;
  onDelete: (row: RubricRow) => void;
  onSetActive: (row: RubricRow) => void;
  isDeleting: boolean;
  isSettingActive: boolean;
}

function RubricRowActions({
  row,
  orgId,
  activeRubricId,
  onEdit,
  onDryRun,
  onDelete,
  onSetActive,
  isDeleting,
  isSettingActive,
}: RowActionsProps) {
  const { can } = usePermissions();
  const t = useTranslations("evaluator.rubrics");
  const tCommon = useTranslations("common");
  const confirm = useConfirm();
  const isPlatformDefault = row.orgId === null;
  const canUpdate = !isPlatformDefault && can({ type: "rubric.update", orgId, rubricId: row.id });
  const canDelete = !isPlatformDefault && can({ type: "rubric.delete", orgId, rubricId: row.id });
  const canSetActive = can({ type: "rubric.update", orgId, rubricId: row.id });
  const isActive = activeRubricId === row.id;

  const handleDelete = async () => {
    const ok = await confirm({
      description: t("confirmDelete", { name: row.name }),
      destructive: true,
    });
    if (!ok) return;
    onDelete(row);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0"
          aria-label={t("actionsAriaLabel", { name: row.name })}
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => onDryRun(row)}>
          <FlaskConical className="h-4 w-4" />
          {t("dryRun7")}
        </DropdownMenuItem>

        {canSetActive && !isActive && (
          <DropdownMenuItem onSelect={() => onSetActive(row)} disabled={isSettingActive}>
            {t("setAsActive")}
          </DropdownMenuItem>
        )}

        {canUpdate && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onEdit(row)}>
              {tCommon("edit")}
            </DropdownMenuItem>
          </>
        )}

        {canDelete && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={handleDelete}
              disabled={isDeleting}
              className="text-destructive focus:text-destructive"
            >
              {isDeleting ? tCommon("deleting") : tCommon("delete")}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

interface RubricListProps {
  orgId: string;
}

export function RubricList({ orgId }: RubricListProps) {
  const utils = trpc.useUtils();
  const { can } = usePermissions();
  const t = useTranslations("evaluator.rubrics");
  const tCommon = useTranslations("common");
  const canCreate = can({ type: "rubric.create", orgId });

  const { data: rubrics, isLoading, error } = trpc.rubrics.list.useQuery({ orgId });

  // Active rubric id comes from the settings query
  const { data: settings } = trpc.contentCapture.getSettings.useQuery({ orgId });
  const activeRubricId = settings?.rubricId ?? null;

  const [editingRow, setEditingRow] = useState<RubricRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [dryRunTarget, setDryRunTarget] = useState<RubricRow | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [settingActiveId, setSettingActiveId] = useState<string | null>(null);

  const del = trpc.rubrics.delete.useMutation({
    onSuccess: () => {
      toast.success(t("deletedToast"));
      utils.rubrics.list.invalidate({ orgId });
    },
    onError: (e) => {
      const code = (e.data as { code?: string } | undefined)?.code;
      if (code === "CONFLICT") {
        toast.error(t("cannotDeleteActive"));
      } else if (code === "FORBIDDEN") {
        toast.error(tCommon("insufficientPermission"));
      } else {
        toast.error(e.message || t("deleteFail"));
      }
    },
    onSettled: () => setDeletingId(null),
  });

  const setActive = trpc.rubrics.setActive.useMutation({
    onSuccess: () => {
      toast.success(t("activeUpdatedToast"));
      utils.rubrics.list.invalidate({ orgId });
      utils.contentCapture.getSettings.invalidate({ orgId });
    },
    onError: (e) => {
      const code = (e.data as { code?: string } | undefined)?.code;
      toast.error(
        code === "FORBIDDEN" ? tCommon("insufficientPermission") : e.message || t("setActiveFail"),
      );
    },
    onSettled: () => setSettingActiveId(null),
  });

  const handleDelete = (row: RubricRow) => {
    setDeletingId(row.id);
    del.mutate({ rubricId: row.id, orgId });
  };

  const handleSetActive = (row: RubricRow) => {
    setSettingActiveId(row.id);
    setActive.mutate({ orgId, rubricId: row.id });
  };

  const handleEditorClose = () => {
    setEditingRow(null);
    setCreating(false);
  };

  const handleEditorSuccess = () => {
    handleEditorClose();
    utils.rubrics.list.invalidate({ orgId });
  };

  const headerCta = canCreate ? (
    <div className="flex justify-end">
      <Button size="sm" className="gap-1.5" onClick={() => setCreating(true)}>
        <Plus className="h-4 w-4" />
        {t("newRubric")}
      </Button>
    </div>
  ) : null;

  if (isLoading) {
    return (
      <div className="space-y-4">
        {headerCta}
        <Card className="shadow-card p-6 text-sm text-muted-foreground">
          {t("loadingRubrics")}
        </Card>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-4">
        {headerCta}
        <Card className="shadow-card flex flex-col items-center p-10 text-center">
          <ShieldAlert className="h-6 w-6 text-muted-foreground" />
          <h3 className="mt-3 text-sm font-semibold">{t("unableToLoad")}</h3>
          <p className="mt-1 max-w-sm text-xs text-muted-foreground">
            {error.message}
          </p>
        </Card>
      </div>
    );
  }

  if (!rubrics || rubrics.length === 0) {
    return (
      <div className="space-y-4">
        {headerCta}
        <Card className="shadow-card flex flex-col items-center p-10 text-center">
          <BookOpen className="h-6 w-6 text-muted-foreground" />
          <h3 className="mt-3 text-sm font-semibold">{t("emptyTitle")}</h3>
          <p className="mt-1 max-w-sm text-xs text-muted-foreground">
            {t("emptyHint")}
          </p>
          {canCreate && (
            <Button size="sm" className="mt-4 gap-1.5" onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" />
              {t("newRubric")}
            </Button>
          )}
        </Card>

        {(creating || editingRow) && (
          <RubricEditor
            orgId={orgId}
            editingRow={editingRow}
            onSuccess={handleEditorSuccess}
            onCancel={handleEditorClose}
          />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {headerCta}

      <Card className="shadow-card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/30 text-xs text-muted-foreground">
              <th scope="col" className="px-4 py-2 text-left font-medium">{t("name")}</th>
              <th scope="col" className="px-4 py-2 text-left font-medium">{t("version")}</th>
              <th scope="col" className="px-4 py-2 text-left font-medium">{t("source")}</th>
              <th scope="col" className="px-4 py-2 text-left font-medium">{t("status")}</th>
              <th scope="col" className="px-4 py-2 text-right font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {rubrics.map((row) => {
              const isPlatformDefault = row.orgId === null;
              const isActive = activeRubricId === row.id;
              return (
                <tr
                  key={row.id}
                  className="border-b border-border last:border-0 hover:bg-accent/20"
                >
                  <td className="px-4 py-2.5 font-medium">
                    <span>{row.name}</span>
                    {row.description && (
                      <p className="text-xs text-muted-foreground font-normal mt-0.5 truncate max-w-xs">
                        {row.description}
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-muted-foreground tabular-nums">
                    {row.version}
                  </td>
                  <td className="px-4 py-2.5">
                    {isPlatformDefault ? (
                      <Badge variant="secondary" className="text-xs">{t("platformBadge")}</Badge>
                    ) : (
                      <Badge variant="outline" className="text-xs">{t("custom")}</Badge>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    {isActive ? (
                      <Badge className="text-xs bg-green-100 text-green-800 border-green-200">
                        {t("active")}
                      </Badge>
                    ) : row.isDefault ? (
                      <Badge variant="secondary" className="text-xs">{t("default")}</Badge>
                    ) : null}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <RubricRowActions
                      row={row}
                      orgId={orgId}
                      activeRubricId={activeRubricId}
                      onEdit={setEditingRow}
                      onDryRun={setDryRunTarget}
                      onDelete={handleDelete}
                      onSetActive={handleSetActive}
                      isDeleting={deletingId === row.id}
                      isSettingActive={settingActiveId === row.id}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      {(creating || editingRow) && (
        <RubricEditor
          orgId={orgId}
          editingRow={editingRow}
          onSuccess={handleEditorSuccess}
          onCancel={handleEditorClose}
        />
      )}

      {dryRunTarget && (
        <DryRunPreview
          orgId={orgId}
          rubric={dryRunTarget}
          onClose={() => setDryRunTarget(null)}
        />
      )}
    </div>
  );
}

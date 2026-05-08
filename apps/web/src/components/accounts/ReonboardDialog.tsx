"use client";

import { useState } from "react";
import { Copy, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";

const TEXTAREA_CLASS =
  "flex w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

// Single-line so the user can paste directly into a shell without
// indentation getting in python's way (heredoc + leading whitespace =
// IndentationError). Display-side wrapping is whitespace-pre-wrap so
// the user still sees logical breaks.
const KEYCHAIN_EXTRACT_CMD =
  `security find-generic-password -s 'Claude Code-credentials' -w | ` +
  `python3 -c 'import sys, json; from datetime import datetime, timezone; ` +
  `oa = json.load(sys.stdin)["claudeAiOauth"]; ` +
  `print(json.dumps({` +
  `"access_token": oa["accessToken"], ` +
  `"refresh_token": oa["refreshToken"], ` +
  `"expires_at": datetime.fromtimestamp(oa["expiresAt"]/1000, tz=timezone.utc)` +
  `.isoformat().replace("+00:00", "Z")` +
  `}))'`;

function isValidJson(s: string): boolean {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

interface ReonboardDialogProps {
  /** Account being re-onboarded. Pass null to close. */
  account: { id: string; name: string } | null;
  /** Org id used to invalidate the accounts.list query after success. */
  orgId: string;
  onClose: () => void;
}

/**
 * Re-onboard dialog for OAuth accounts auto-paused by
 * `oauth_invalid_grant` (issue #92 sub-task 2 follow-up).
 *
 * The aide gateway runs in Docker; the macOS Keychain lives on the
 * host. We can't extract the bundle from inside the container, so the
 * operator runs a one-liner in their host terminal and pastes the
 * result here. The mutation handles encryption + DB update + state
 * reset (status='active', schedulable=true, fail_count=0).
 */
export function ReonboardDialog({
  account,
  orgId,
  onClose,
}: ReonboardDialogProps) {
  const utils = trpc.useUtils();
  const [credentials, setCredentials] = useState("");

  const reonboard = trpc.accounts.reonboard.useMutation({
    onSuccess: () => {
      toast.success("Account re-onboarded successfully");
      utils.accounts.list.invalidate({ orgId });
      setCredentials("");
      onClose();
    },
    onError: (e) => {
      const code = (e.data as { code?: string } | undefined)?.code;
      if (code === "FORBIDDEN") {
        toast.error("You do not have permission to re-onboard this account");
      } else if (code === "BAD_REQUEST") {
        toast.error(e.message || "Invalid credentials format");
      } else {
        toast.error(e.message || "Re-onboard failed");
      }
    },
  });

  const open = account !== null;
  const trimmed = credentials.trim();
  const hasInput = trimmed.length > 0;
  const validJson = hasInput && isValidJson(trimmed);
  const submitDisabled = !validJson || reonboard.isPending;

  const handleSubmit = () => {
    if (!account || !validJson) return;
    reonboard.mutate({ id: account.id, credentials: trimmed });
  };

  const copyCmd = async () => {
    try {
      await navigator.clipboard.writeText(KEYCHAIN_EXTRACT_CMD);
      toast.success("Command copied to clipboard");
    } catch {
      toast.error("Clipboard unavailable — copy manually");
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setCredentials("");
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Re-onboard OAuth credentials</DialogTitle>
          <DialogDescription>
            {account
              ? `Replace the rotated bundle for "${account.name}" with a fresh one from your Keychain.`
              : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label className="text-xs font-medium">
              1. Run this in a terminal on the gateway host
            </Label>
            <div className="relative">
              <pre className="whitespace-pre-wrap break-all rounded-md border border-input bg-muted/30 p-3 pr-12 text-xs leading-relaxed">
                {KEYCHAIN_EXTRACT_CMD}
              </pre>
              <Button
                variant="ghost"
                size="sm"
                className="absolute right-1.5 top-1.5 h-7 w-7 p-0"
                onClick={copyCmd}
                aria-label="Copy command"
              >
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Reads the Claude Code app&rsquo;s Keychain entry and reshapes it
              into the JSON shape aide stores. Output goes to stdout — copy it
              into the box below.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="reonboard-credentials" className="text-xs font-medium">
              2. Paste the JSON output here
            </Label>
            <textarea
              id="reonboard-credentials"
              value={credentials}
              onChange={(e) => setCredentials(e.target.value)}
              placeholder='{"access_token":"sk-ant-oat01-...","refresh_token":"sk-ant-ort01-...","expires_at":"2026-..."}'
              rows={6}
              className={TEXTAREA_CLASS}
              disabled={reonboard.isPending}
            />
            {hasInput && !validJson && (
              <p className="text-xs text-destructive">
                Not valid JSON — make sure you copied the entire output.
              </p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={reonboard.isPending}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={submitDisabled}>
            {reonboard.isPending && (
              <Loader2 className="h-4 w-4 animate-spin" />
            )}
            Re-onboard
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

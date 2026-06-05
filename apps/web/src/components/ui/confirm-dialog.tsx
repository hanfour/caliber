"use client";

import * as React from "react";
import { useTranslations } from "next-intl";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export interface ConfirmOptions {
  /** Heading. Defaults to the localized "Are you sure?". */
  title?: string;
  /** Body text — usually the localized "Delete <name>?" prompt. */
  description: React.ReactNode;
  /** Confirm button label. Defaults to the localized "Confirm". */
  confirmLabel?: string;
  /** Cancel button label. Defaults to the localized "Cancel". */
  cancelLabel?: string;
  /** Render the confirm button in the destructive (red) variant. */
  destructive?: boolean;
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = React.createContext<ConfirmFn | null>(null);

/**
 * Returns an async `confirm(options)` that resolves `true` if the user accepts
 * and `false` if they cancel / dismiss. Drop-in replacement for the native
 * `window.confirm`, but rendered as an in-app, focus-trapped modal:
 *
 *   const confirm = useConfirm();
 *   const ok = await confirm({ description: t("confirmRevoke", { name }), destructive: true });
 *   if (!ok) return;
 */
export function useConfirm(): ConfirmFn {
  const ctx = React.useContext(ConfirmContext);
  if (!ctx) {
    throw new Error("useConfirm must be used within a ConfirmDialogProvider");
  }
  return ctx;
}

interface DialogState {
  open: boolean;
  options: ConfirmOptions | null;
}

/**
 * Hosts a single confirm dialog for the subtree and exposes {@link useConfirm}.
 * Mount once near the root (e.g. the dashboard layout).
 */
export function ConfirmDialogProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const t = useTranslations("common");
  const [state, setState] = React.useState<DialogState>({
    open: false,
    options: null,
  });
  const resolverRef = React.useRef<((value: boolean) => void) | null>(null);

  const settle = React.useCallback((result: boolean) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setState((prev) => ({ ...prev, open: false }));
    resolve?.(result);
  }, []);

  const confirm = React.useCallback<ConfirmFn>((options) => {
    return new Promise<boolean>((resolve) => {
      // If a prior prompt is somehow still pending, cancel it first.
      resolverRef.current?.(false);
      resolverRef.current = resolve;
      setState({ open: true, options });
    });
  }, []);

  // If the provider unmounts with a prompt still open, settle it as cancelled
  // so the awaiting caller never hangs and the resolver isn't leaked.
  React.useEffect(() => {
    return () => {
      resolverRef.current?.(false);
      resolverRef.current = null;
    };
  }, []);

  // Escape, overlay click, or the close button all close the dialog → cancel.
  const handleOpenChange = React.useCallback(
    (open: boolean) => {
      if (!open) settle(false);
    },
    [settle],
  );

  const options = state.options;

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog open={state.open} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{options?.title ?? t("confirmTitle")}</DialogTitle>
            {options?.description != null && (
              <DialogDescription>{options.description}</DialogDescription>
            )}
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => settle(false)}>
              {options?.cancelLabel ?? t("cancel")}
            </Button>
            <Button
              variant={options?.destructive ? "destructive" : "default"}
              onClick={() => settle(true)}
            >
              {options?.confirmLabel ?? t("confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ConfirmContext.Provider>
  );
}

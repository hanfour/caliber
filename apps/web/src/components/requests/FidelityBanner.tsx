"use client";

import { useTranslations } from "next-intl";

interface Fidelity {
  toolResultTruncated: boolean;
  originalCacheReadTokens: number;
  originalAccountId: string | null;
  originalAccountStillExists: boolean;
  streamingDisabled: boolean;
}

interface Props {
  fidelity: Fidelity | null;
  comparableCost: boolean;
  sourceCacheReadTokens: number;
}

/**
 * Everything that makes the two sides less than like-for-like, stated BEFORE
 * the reader sees either of them.
 *
 * Placement is the whole point: a caveat rendered under the thing it qualifies
 * has already failed — by the time it is read, the comparison has been made.
 * The caller must keep this above `comparison-content`; the E2E asserts the
 * two boxes' positions rather than their mere presence for exactly that
 * reason.
 *
 * The streaming line is unconditional: replay always forces `stream: false`,
 * so it is a property of the feature, not of any particular run — which is
 * also why it must not wait for `fidelity` to load.
 */
export function FidelityBanner({
  fidelity,
  comparableCost,
  sourceCacheReadTokens,
}: Props) {
  const t = useTranslations("replayComparison");

  const notes: string[] = [t("bannerStreaming")];
  if (!comparableCost) {
    notes.push(t("bannerCache", { tokens: sourceCacheReadTokens }));
  }
  if (fidelity?.toolResultTruncated) notes.push(t("bannerToolResult"));
  if (fidelity && !fidelity.originalAccountStillExists) {
    notes.push(t("bannerAccountGone"));
  }

  return (
    <div
      data-testid="fidelity-banner"
      role="note"
      className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200"
    >
      <p className="font-medium">{t("bannerTitle")}</p>
      <ul className="mt-1.5 list-disc space-y-1 pl-5 text-xs leading-relaxed">
        {notes.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
    </div>
  );
}

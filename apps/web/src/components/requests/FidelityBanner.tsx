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
  /**
   * The run HAD a fidelity record and it could not be read (see
   * `services/replayComparison.ts`). Distinct from `fidelity === null` alone,
   * which also covers a run that legitimately never recorded one.
   */
  fidelityUnreadable: boolean;
  comparableCost: boolean;
  sourceCacheReadTokens: number;
  /** `null` while there is no replay side to report on yet. */
  replayCacheReadTokens: number | null;
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
  fidelityUnreadable,
  comparableCost,
  sourceCacheReadTokens,
  replayCacheReadTokens,
}: Props) {
  const t = useTranslations("replayComparison");

  const notes: string[] = [t("bannerStreaming")];
  // Which SIDE read from cache is stated explicitly, because either one can.
  // The replay inherits the original's cache_control markers verbatim, so a
  // second same-model baseline inside the cache TTL reads warm while the
  // original stayed cold — and a line that always blamed "the original" would
  // then be simply false.
  if (!comparableCost) {
    notes.push(t("bannerCost"));
    if (sourceCacheReadTokens > 0) {
      notes.push(t("bannerCacheSource", { tokens: sourceCacheReadTokens }));
    }
    if (replayCacheReadTokens !== null && replayCacheReadTokens > 0) {
      notes.push(t("bannerCacheReplay", { tokens: replayCacheReadTokens }));
    }
  }
  if (fidelity?.toolResultTruncated) notes.push(t("bannerToolResult"));
  if (fidelity && !fidelity.originalAccountStillExists) {
    notes.push(t("bannerAccountGone"));
  }
  // Under-warning is the one direction this banner must not fail in. An
  // unreadable fidelity record silently removes the two caveats above from the
  // list, and a comparison MISSING a caveat reads as more like-for-like than it
  // is — turning an honest comparison into a misleading one. Saying "we could
  // not read it" is the honest floor.
  if (fidelityUnreadable) notes.push(t("bannerFidelityUnreadable"));

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

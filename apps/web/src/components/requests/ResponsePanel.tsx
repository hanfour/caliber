"use client";

import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import type { DiffLine } from "./lineDiff";

interface Props {
  testId: "source-response" | "replay-response";
  title: string;
  /** Aligned lines, or null when there is nothing to show. */
  lines: DiffLine[] | null;
  /** Shown in place of the body when `lines` is null. */
  emptyText: string;
  /** True when the bodies were too large to align line by line. */
  diffSkipped: boolean;
}

/**
 * One side of the comparison.
 *
 * A missing body renders an explicit sentence, never an empty <pre>: a blank
 * panel reads like "the model returned nothing", which is a different — and
 * much more alarming — claim than "we cannot show you this".
 */
export function ResponsePanel({
  testId,
  title,
  lines,
  emptyText,
  diffSkipped,
}: Props) {
  const t = useTranslations("replayComparison");

  return (
    <section
      data-testid={testId}
      className="flex min-w-0 flex-col rounded-md border border-border"
    >
      <header className="border-b border-border bg-muted/30 px-3 py-2 text-xs font-medium">
        {title}
      </header>
      {lines === null ? (
        <p className="px-3 py-4 text-xs text-muted-foreground">{emptyText}</p>
      ) : (
        <>
          {diffSkipped && (
            <p className="border-b border-border px-3 py-1.5 text-[11px] text-muted-foreground">
              {t("diffTooLarge")}
            </p>
          )}
          <pre className="max-h-[28rem] overflow-auto px-3 py-2 text-[11px] leading-relaxed">
            {lines.map((line, i) => (
              <div
                // Index keys are safe here: this list is a rendering of one
                // immutable snapshot and never reorders in place.
                key={i}
                className={cn(
                  "whitespace-pre-wrap break-words",
                  line.op === "changed" &&
                    "bg-amber-100 dark:bg-amber-500/20",
                )}
              >
                {line.text === "" ? " " : line.text}
              </div>
            ))}
          </pre>
        </>
      )}
    </section>
  );
}

# Evaluator Report Explainability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the full "why this score" behind evaluator reports — per-signal hit/miss with thresholds, data provenance, behavioural drill-down, and LLM narrative+evidence — in the admin member report and the user's own profile report.

**Architecture:** A/B/C are pure frontend additions consuming fields `reports.getUser` already returns (+ existing `rubrics.get` for thresholds); no engine or schema change. D wires the already-implemented LLM narrative branch: (1) provision the eval key on `llmEvalEnabled` first-enable, (2) pin eval loopback calls to `llm_eval_account_id` via the scheduler's existing `stickyAccountId` forced path, (3) render `llm_evidence`.

**Tech Stack:** TypeScript, Next.js (App Router) + React + next-intl + Tailwind (web), tRPC + Drizzle (api), Fastify + BullMQ (gateway), vitest + @testing-library/react (web tests), vitest + testcontainers (api/gateway integration tests).

## Global Constraints

- No DB migration. No change to any existing scored value or scoring-engine algorithm.
- Immutability: never mutate props/state/objects in place; return new copies (spread).
- i18n: every new UI string goes into all 5 locales `messages/{en,ja,ko,zh-CN,zh-TW}.json`; `en.json` is source of truth; `apps/web/tests/lib/i18n/messagesParity.test.ts` must stay green.
- No `console.log` in production code.
- eval key raw format is `caliber-eval-<64hex>`; its `apiKeys.keyPrefix` is `caliber-eval` (first 12 chars, per `llmEvalKeyProvisioning.ts:165` `rawKey.slice(0,12)` — NOT `caliber-`). This exact prefix is the trust signal for the gateway account-pin (§Phase 4).
- Web tests: mock `@/lib/trpc/client` BEFORE importing the component; `tests/setup.ts` globally mocks `next-intl` against the real `en.json`, so assert against actual English strings.
- Test commands: web `pnpm --filter @caliber/web test <path>`; api integration `pnpm --filter @caliber/api test:integration <nameFilter>`; gateway integration `pnpm --filter @caliber/gateway exec vitest run <path>`.

---

## File Structure

**Phase 1 — Frontend explainability (A/B/C)**
- Create `apps/web/src/components/evaluator/rubricThreshold.ts` — pure formatter: rubric `Signal` → human-readable threshold string + signal display name.
- Create `apps/web/src/components/evaluator/SignalBreakdown.tsx` — expanded-section content: ALL signals (hit ✓ / miss ✗) with value + threshold + evidence. Replaces `EvidenceRow` as the expansion body.
- Create `apps/web/src/components/evaluator/DataProvenanceCard.tsx` — renders `source_breakdown` / `data_quality` / period counts.
- Modify `apps/web/src/components/evaluator/reportDetailShared.tsx` — extend `SignalHit` type with `type`/`value`; pass rubric-derived thresholds into the expansion; make `SectionRow` accept an optional `rubricSection`.
- Modify `apps/web/src/components/evaluator/ReportDetail.tsx` — drop the inline `SectionRow` duplicate (use shared), fetch `rubrics.get`, mount `DataProvenanceCard` + `FacetSummaryCard`.
- Modify `apps/web/src/components/evaluator/ProfileEvaluation.tsx` — mount `DataProvenanceCard`, pass rubric to shared `SectionRow` (parity with admin view).
- Modify `apps/web/messages/{en,ja,ko,zh-CN,zh-TW}.json` — new keys under `evaluator.report`, `evaluator.provenance`.

**Phase 2 — LLM evidence frontend (D-frontend)**
- Create `apps/web/src/components/evaluator/LlmEvidenceList.tsx` — renders `llm_evidence[]` (quote + rationale + requestId).
- Modify `apps/web/src/components/evaluator/ReportDetail.tsx` — mount it under the narrative card.
- Modify `apps/web/messages/*` — keys under `evaluator.llmEvidence`.

**Phase 3 — Provision wiring (D-backend, api)**
- Modify `apps/api/src/trpc/routers/contentCapture.ts` — on `llmEvalEnabled` false→true, call `provisionLlmEvalKey`.
- Create `apps/api/tests/integration/trpc/contentCaptureProvision.test.ts` — asserts the provision side-effect.

**Phase 4 — Account-pin (D-backend, gateway)**
- Modify `apps/gateway/src/runtime/failoverLoop.ts` — add `stickyAccountId?` to `RunFailoverInput`, forward into `scheduleReq`.
- Create `apps/gateway/src/runtime/evalAccountPin.ts` — reads `x-caliber-eval-account-id` ONLY when the request's api key is an eval key (`keyPrefix === "caliber-eval"`).
- Modify the messages route (`apps/gateway/src/routes/messages.ts`) — thread the pin into `buildFailoverInput`.
- Modify `apps/gateway/src/workers/evaluator/runLlm.ts` — select `llmEvalAccountId`; when set, send `x-caliber-eval-account-id` header.
- Extend `apps/gateway/tests/routes/messages.integration.test.ts` (or a new sibling) — pin hits the chosen account; forged header without eval key is ignored.

---

## Phase 1 — Frontend explainability (A/B/C)

### Task 1: Rubric threshold formatter

Pure function turning a rubric `Signal` (discriminated union from `packages/evaluator/src/rubric/schema.ts`) into a human-readable threshold string. No React, no i18n — returns a stable English/number string the UI wraps. This is the hardest-to-get-right pure logic, so it lands first with full tests.

**Files:**
- Create: `apps/web/src/components/evaluator/rubricThreshold.ts`
- Test: `apps/web/tests/components/evaluator/rubricThreshold.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `formatThreshold(signal: RubricSignal): string` and `type RubricSignal` (a structural subset of the rubric signal shape — id/type + threshold fields). Later tasks import both.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { formatThreshold } from "@/components/evaluator/rubricThreshold";

describe("formatThreshold", () => {
  it("keyword with minRatio → percentage-of-bodies phrasing", () => {
    expect(
      formatThreshold({ type: "keyword", id: "k", minRatio: 0.5 }),
    ).toBe("≥ 50% of bodies contain a term");
  });

  it("keyword without minRatio → any-body phrasing", () => {
    expect(formatThreshold({ type: "keyword", id: "k" })).toBe(
      "any body contains a term",
    );
  });

  it("threshold gte → metric ≥ n", () => {
    expect(
      formatThreshold({ type: "threshold", id: "t", metric: "iteration_count", gte: 3 }),
    ).toBe("iteration_count ≥ 3");
  });

  it("threshold between → metric in [a, b]", () => {
    expect(
      formatThreshold({ type: "threshold", id: "t", metric: "requests", between: [2, 8] }),
    ).toBe("requests in [2, 8]");
  });

  it("refusal_rate lte → refusal_rate ≤ n", () => {
    expect(formatThreshold({ type: "refusal_rate", id: "r", lte: 0.1 })).toBe(
      "refusal_rate ≤ 0.1",
    );
  });

  it("client_mix → ≥ ratio of expected clients", () => {
    expect(
      formatThreshold({ type: "client_mix", id: "c", minRatio: 0.6 }),
    ).toBe("≥ 60% from expected clients");
  });

  it("simple gte families → type ≥ n", () => {
    expect(formatThreshold({ type: "tool_diversity", id: "d", gte: 2 })).toBe(
      "tool_diversity ≥ 2",
    );
  });

  it("extended_thinking_used → used ≥ minCount times", () => {
    expect(
      formatThreshold({ type: "extended_thinking_used", id: "e", minCount: 1 }),
    ).toBe("extended thinking used ≥ 1 times");
  });

  it("unknown/malformed → empty string (graceful)", () => {
    expect(formatThreshold({ type: "mystery", id: "x" } as never)).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @caliber/web test tests/components/evaluator/rubricThreshold.test.ts`
Expected: FAIL — cannot find module `rubricThreshold`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/web/src/components/evaluator/rubricThreshold.ts
// Pure formatter: a rubric signal definition → human-readable threshold text.
// Mirrors the discriminated union in packages/evaluator/src/rubric/schema.ts,
// but structural (the report only needs id/type + threshold fields to explain
// "what it takes to hit this signal").

export interface RubricSignal {
  id: string;
  type: string;
  // threshold-family fields (present depending on `type`)
  metric?: string;
  gte?: number;
  lte?: number;
  between?: [number, number];
  minRatio?: number;
  minCount?: number;
}

function pct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export function formatThreshold(signal: RubricSignal): string {
  switch (signal.type) {
    case "keyword":
      return signal.minRatio != null
        ? `≥ ${pct(signal.minRatio)} of bodies contain a term`
        : "any body contains a term";
    case "threshold": {
      const m = signal.metric ?? "metric";
      if (signal.between) return `${m} in [${signal.between[0]}, ${signal.between[1]}]`;
      if (signal.gte != null) return `${m} ≥ ${signal.gte}`;
      if (signal.lte != null) return `${m} ≤ ${signal.lte}`;
      return m;
    }
    case "refusal_rate":
      return `refusal_rate ≤ ${signal.lte}`;
    case "client_mix":
      return `≥ ${pct(signal.minRatio ?? 0)} from expected clients`;
    case "extended_thinking_used":
      return `extended thinking used ≥ ${signal.minCount} times`;
    case "model_diversity":
    case "cache_read_ratio":
    case "tool_diversity":
    case "iteration_count":
      return `${signal.type} ≥ ${signal.gte}`;
    case "facet_claude_helpfulness":
    case "facet_bugs_caught":
    case "facet_outcome_success_rate":
    case "facet_session_type_ratio":
      return `${signal.type} ≥ ${signal.gte}`;
    case "facet_friction_per_session":
    case "facet_codex_errors":
      return `${signal.type} ≤ ${signal.lte}`;
    default:
      return "";
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @caliber/web test tests/components/evaluator/rubricThreshold.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/evaluator/rubricThreshold.ts apps/web/tests/components/evaluator/rubricThreshold.test.ts
git commit -m "feat(web): rubric threshold formatter for signal explainability"
```

---

### Task 2: SignalBreakdown component (A — all signals, hit/miss, threshold)

Replaces `EvidenceRow` as the section-expansion body. Shows EVERY signal (not just hit+evidence): a ✓/✗ marker, the signal id, its measured `value`, its rubric threshold (when a matching rubric signal is supplied), and — for hits with evidence — the existing quote blocks.

**Files:**
- Create: `apps/web/src/components/evaluator/SignalBreakdown.tsx`
- Test: `apps/web/tests/components/evaluator/SignalBreakdown.test.tsx`

**Interfaces:**
- Consumes: `formatThreshold`, `RubricSignal` (Task 1); `EvidenceItem` (existing, from `EvidenceRow`).
- Produces: `SignalBreakdown({ signals, rubricSignals })` where
  `signals: Array<{ id; type; hit; value?; evidence? }>` and
  `rubricSignals?: Record<string, RubricSignal>` (id → rubric definition).
  `SectionRow` (Task 3) renders this in the expansion.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SignalBreakdown } from "@/components/evaluator/SignalBreakdown";

const rubricSignals = {
  iter: { id: "iter", type: "iteration_count", gte: 3 },
  kw: { id: "kw", type: "keyword", minRatio: 0.5 },
};

describe("SignalBreakdown", () => {
  it("shows a hit signal with its value and threshold", () => {
    render(
      <SignalBreakdown
        signals={[{ id: "iter", type: "iteration_count", hit: true, value: 5 }]}
        rubricSignals={rubricSignals}
      />,
    );
    expect(screen.getByText("iter")).toBeInTheDocument();
    expect(screen.getByText(/iteration_count ≥ 3/)).toBeInTheDocument();
    // measured value surfaced
    expect(screen.getByText(/5/)).toBeInTheDocument();
  });

  it("shows a MISSED signal (this is the whole point — why the score isn't higher)", () => {
    render(
      <SignalBreakdown
        signals={[{ id: "kw", type: "keyword", hit: false }]}
        rubricSignals={rubricSignals}
      />,
    );
    const row = screen.getByTestId("signal-kw");
    expect(row).toHaveAttribute("data-hit", "false");
    expect(screen.getByText(/≥ 50% of bodies contain a term/)).toBeInTheDocument();
  });

  it("renders evidence quotes for hits that carry evidence", () => {
    render(
      <SignalBreakdown
        signals={[
          {
            id: "kw",
            type: "keyword",
            hit: true,
            evidence: [{ quote: "let's compare", requestId: "req-1", offset: 0 }],
          },
        ]}
        rubricSignals={rubricSignals}
      />,
    );
    expect(screen.getByText(/let's compare/)).toBeInTheDocument();
    expect(screen.getByText(/req-1/)).toBeInTheDocument();
  });

  it("degrades gracefully with no rubricSignals (no threshold shown, no crash)", () => {
    render(
      <SignalBreakdown
        signals={[{ id: "iter", type: "iteration_count", hit: true, value: 5 }]}
      />,
    );
    expect(screen.getByText("iter")).toBeInTheDocument();
  });

  it("renders empty state when there are no signals", () => {
    render(<SignalBreakdown signals={[]} />);
    expect(screen.getByText(/No signals/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @caliber/web test tests/components/evaluator/SignalBreakdown.test.tsx`
Expected: FAIL — cannot find module `SignalBreakdown`.

- [ ] **Step 3: Write minimal implementation**

```tsx
// apps/web/src/components/evaluator/SignalBreakdown.tsx
"use client";

import { Check, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { formatThreshold, type RubricSignal } from "./rubricThreshold";
import type { EvidenceItem } from "./EvidenceRow";

export interface BreakdownSignal {
  id: string;
  type: string;
  hit: boolean;
  value?: number;
  evidence?: EvidenceItem[];
}

interface Props {
  signals: BreakdownSignal[];
  rubricSignals?: Record<string, RubricSignal>;
}

export function SignalBreakdown({ signals, rubricSignals }: Props) {
  const t = useTranslations("evaluator.report");

  if (signals.length === 0) {
    return (
      <div className="px-4 py-3 text-xs text-muted-foreground">
        {t("noSignals")}
      </div>
    );
  }

  return (
    <div className="space-y-2 px-4 py-3">
      {signals.map((s) => {
        const rubricSignal = rubricSignals?.[s.id];
        const threshold = rubricSignal ? formatThreshold(rubricSignal) : "";
        const evidence =
          s.hit && s.evidence && s.evidence.length > 0 ? s.evidence : [];
        return (
          <div
            key={s.id}
            data-testid={`signal-${s.id}`}
            data-hit={s.hit ? "true" : "false"}
            className="rounded-md border border-border bg-muted/20 px-3 py-2 space-y-1"
          >
            <div className="flex items-center gap-2">
              {s.hit ? (
                <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
              ) : (
                <X className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              )}
              <span className="font-mono text-xs font-medium">{s.id}</span>
              {s.value != null && (
                <span className="text-[10px] text-muted-foreground tabular-nums">
                  {t("actualValue", { value: s.value })}
                </span>
              )}
            </div>
            {threshold && (
              <p className="ml-5.5 text-[10px] text-muted-foreground">
                {t("thresholdLabel")}{" "}
                <span className="font-mono">{threshold}</span>
              </p>
            )}
            {evidence.map((ev, idx) => (
              <div key={idx} className="ml-5.5 space-y-1">
                <blockquote className="text-xs italic text-foreground leading-relaxed">
                  &ldquo;{ev.quote}&rdquo;
                </blockquote>
                {ev.requestId && (
                  <p className="font-mono text-[10px] text-muted-foreground">
                    {t("requestId")}{" "}
                    <span className="select-all">{ev.requestId}</span>
                  </p>
                )}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Add the i18n keys used above**

Add to `apps/web/messages/en.json` under `evaluator.report` (and mirror into ja/ko/zh-CN/zh-TW with translated values):

```json
"noSignals": "No signals recorded for this section.",
"actualValue": "measured: {value}",
"thresholdLabel": "threshold:"
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @caliber/web test tests/components/evaluator/SignalBreakdown.test.tsx`
Expected: PASS (5 tests).
Run: `pnpm --filter @caliber/web test tests/lib/i18n/messagesParity.test.ts`
Expected: PASS (all locales carry the 3 new keys).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/evaluator/SignalBreakdown.tsx apps/web/tests/components/evaluator/SignalBreakdown.test.tsx apps/web/messages
git commit -m "feat(web): SignalBreakdown — all signals with hit/miss + threshold"
```

---

### Task 3: Wire SignalBreakdown into shared SectionRow

`reportDetailShared.tsx`'s `SectionRow` currently maps signals down to `{id,hit,evidence}` and renders `EvidenceRow` (hits-with-evidence only). Extend it to pass the full signal (`type`/`value`) and an optional per-section rubric map into `SignalBreakdown`. Keep `EvidenceRow` file in place (still imported by nothing after this — remove its import here).

**Files:**
- Modify: `apps/web/src/components/evaluator/reportDetailShared.tsx`
- Test: `apps/web/tests/components/evaluator/reportDetailShared.test.tsx`

**Interfaces:**
- Consumes: `SignalBreakdown`, `BreakdownSignal` (Task 2); `RubricSignal` (Task 1).
- Produces: `SectionRow({ section, rubricSection? })` where `rubricSection?: { signals: RubricSignal[] }`. `SectionResult.signals[]` now typed with `type` + `value`. `ReportDetail`/`ProfileEvaluation` (Tasks 5/6) pass `rubricSection`.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SectionRow, type SectionResult } from "@/components/evaluator/reportDetailShared";

const section: SectionResult = {
  sectionId: "interaction",
  name: "Interaction",
  weight: 50,
  standardScore: 100,
  superiorScore: 120,
  score: 100,
  label: "Standard",
  signals: [
    { id: "kw", type: "keyword", hit: false },
    { id: "iter", type: "iteration_count", hit: true, value: 5 },
  ],
};

it("expands to show ALL signals including the missed one, with thresholds", () => {
  render(
    <table>
      <tbody>
        <SectionRow
          section={section}
          rubricSection={{
            signals: [
              { id: "kw", type: "keyword", minRatio: 0.5 },
              { id: "iter", type: "iteration_count", gte: 3 },
            ],
          }}
        />
      </tbody>
    </table>,
  );
  fireEvent.click(screen.getByText("Interaction"));
  expect(screen.getByTestId("signal-kw")).toHaveAttribute("data-hit", "false");
  expect(screen.getByTestId("signal-iter")).toHaveAttribute("data-hit", "true");
  expect(screen.getByText(/≥ 50% of bodies contain a term/)).toBeInTheDocument();
  expect(screen.getByText(/iteration_count ≥ 3/)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @caliber/web test tests/components/evaluator/reportDetailShared.test.tsx`
Expected: FAIL — `rubricSection` prop unknown / thresholds not rendered.

- [ ] **Step 3: Edit `reportDetailShared.tsx`**

Replace the `SignalHit` interface (lines 17-23) to carry `type` and keep `value`:

```tsx
export interface SignalHit {
  id: string;
  type: string;
  hit: boolean;
  value?: number;
  evidence?: EvidenceItem[];
}
```

Replace the import block (lines 6-7) — drop `EvidenceRow`, add `SignalBreakdown`:

```tsx
import { SignalBreakdown, type BreakdownSignal } from "./SignalBreakdown";
import type { RubricSignal } from "./rubricThreshold";
```

Replace `SectionRowProps` + the mapping + the expansion `<td>` (lines 54-119). New props and body:

```tsx
interface SectionRowProps {
  section: SectionResult;
  rubricSection?: { signals: RubricSignal[] };
}

export function SectionRow({ section, rubricSection }: SectionRowProps) {
  const [expanded, setExpanded] = useState(false);
  const t = useTranslations("evaluator.report");

  const signals: BreakdownSignal[] = section.signals.map((s) => ({
    id: s.id,
    type: s.type,
    hit: s.hit,
    value: s.value,
    evidence: s.evidence,
  }));

  const rubricSignals: Record<string, RubricSignal> | undefined =
    rubricSection
      ? Object.fromEntries(rubricSection.signals.map((rs) => [rs.id, rs]))
      : undefined;

  const isSuperior =
    section.score === section.superiorScore &&
    section.superiorScore > section.standardScore;

  return (
    <>
      {/* ...unchanged <tr> header row (name/score/weight/label)... */}
      {expanded && (
        <tr className="border-b border-border bg-muted/20">
          <td colSpan={4} className="p-0">
            <SignalBreakdown signals={signals} rubricSignals={rubricSignals} />
          </td>
        </tr>
      )}
    </>
  );
}
```

Keep the existing `<tr>` header markup (lines 74-112) byte-for-byte — only the props signature, the `signals` mapping, the new `rubricSignals`, and the expansion `<td>` change.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @caliber/web test tests/components/evaluator/reportDetailShared.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/evaluator/reportDetailShared.tsx apps/web/tests/components/evaluator/reportDetailShared.test.tsx
git commit -m "feat(web): SectionRow renders full signal breakdown with rubric thresholds"
```

---

### Task 4: DataProvenanceCard (B — source + coverage)

Renders the three stored-but-never-shown fields: `sourceBreakdown` (gateway vs telemetry events), `dataQuality` (coverage ratio + captured/missing/truncated), and the period counts from `signalsSummary.period`. Pure presentational; hidden entirely when no data-quality object exists.

**Files:**
- Create: `apps/web/src/components/evaluator/DataProvenanceCard.tsx`
- Test: `apps/web/tests/components/evaluator/DataProvenanceCard.test.tsx`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `DataProvenanceCard({ sourceBreakdown, dataQuality, period })` with
  `sourceBreakdown?: { gateway_events?: number; transcript_events?: number; overlap?: number } | null`,
  `dataQuality?: { coverageRatio?: number; capturedRequests?: number; missingBodies?: number; truncatedBodies?: number; totalRequests?: number } | null`,
  `period?: { requestCount?: number; bodyCount?: number } | null`.
  Tasks 5/6 pass fields off the report row.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { DataProvenanceCard } from "@/components/evaluator/DataProvenanceCard";

it("renders source split and coverage", () => {
  render(
    <DataProvenanceCard
      sourceBreakdown={{ gateway_events: 12, transcript_events: 1823 }}
      dataQuality={{ coverageRatio: 0.87, capturedRequests: 100, missingBodies: 15, totalRequests: 115 }}
      period={{ requestCount: 115, bodyCount: 100 }}
    />,
  );
  expect(screen.getByText(/1823/)).toBeInTheDocument(); // telemetry events
  expect(screen.getByText(/12/)).toBeInTheDocument(); // gateway events
  expect(screen.getByText(/87%/)).toBeInTheDocument(); // coverage
});

it("returns null when no dataQuality (nothing to explain)", () => {
  const { container } = render(<DataProvenanceCard />);
  expect(container.firstChild).toBeNull();
});

it("handles null sourceBreakdown (per-key reports) without crashing", () => {
  render(
    <DataProvenanceCard
      sourceBreakdown={null}
      dataQuality={{ coverageRatio: 0.5 }}
    />,
  );
  expect(screen.getByText(/50%/)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @caliber/web test tests/components/evaluator/DataProvenanceCard.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```tsx
// apps/web/src/components/evaluator/DataProvenanceCard.tsx
"use client";

import { useTranslations } from "next-intl";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface Props {
  sourceBreakdown?: { gateway_events?: number; transcript_events?: number; overlap?: number } | null;
  dataQuality?: {
    coverageRatio?: number;
    capturedRequests?: number;
    missingBodies?: number;
    truncatedBodies?: number;
    totalRequests?: number;
  } | null;
  period?: { requestCount?: number; bodyCount?: number } | null;
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <dt className="text-muted-foreground text-xs uppercase">{label}</dt>
      <dd className="text-base font-medium tabular-nums">{value}</dd>
    </div>
  );
}

export function DataProvenanceCard({ sourceBreakdown, dataQuality, period }: Props) {
  const t = useTranslations("evaluator.provenance");
  if (!dataQuality) return null;

  const coverage =
    dataQuality.coverageRatio != null
      ? `${Math.round(dataQuality.coverageRatio * 100)}%`
      : "—";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-semibold">{t("title")}</CardTitle>
        <CardDescription className="text-xs">{t("description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
          <Stat label={t("gatewayEvents")} value={sourceBreakdown?.gateway_events ?? 0} />
          <Stat label={t("telemetryEvents")} value={sourceBreakdown?.transcript_events ?? 0} />
          <Stat label={t("coverage")} value={coverage} />
          <Stat label={t("captured")} value={dataQuality.capturedRequests ?? 0} />
          {dataQuality.missingBodies != null && (
            <Stat label={t("missingBodies")} value={dataQuality.missingBodies} />
          )}
          {dataQuality.truncatedBodies != null && (
            <Stat label={t("truncatedBodies")} value={dataQuality.truncatedBodies} />
          )}
          {period?.requestCount != null && (
            <Stat label={t("requests")} value={period.requestCount} />
          )}
          {period?.bodyCount != null && (
            <Stat label={t("bodies")} value={period.bodyCount} />
          )}
        </dl>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 4: Add i18n keys**

Add a new `evaluator.provenance` object to `en.json` (mirror into all 5 locales):

```json
"provenance": {
  "title": "Data provenance & coverage",
  "description": "What data this score was computed from.",
  "gatewayEvents": "Gateway events",
  "telemetryEvents": "Telemetry events",
  "coverage": "Body coverage",
  "captured": "Captured requests",
  "missingBodies": "Missing bodies",
  "truncatedBodies": "Truncated bodies",
  "requests": "Requests",
  "bodies": "Bodies"
}
```

- [ ] **Step 5: Run tests + parity**

Run: `pnpm --filter @caliber/web test tests/components/evaluator/DataProvenanceCard.test.tsx`
Expected: PASS (3 tests).
Run: `pnpm --filter @caliber/web test tests/lib/i18n/messagesParity.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/evaluator/DataProvenanceCard.tsx apps/web/tests/components/evaluator/DataProvenanceCard.test.tsx apps/web/messages
git commit -m "feat(web): DataProvenanceCard — source split + body coverage"
```

---

### Task 5: Integrate into ReportDetail (admin member view)

Drop the inline `SectionRow` duplicate (use the shared one), fetch the report's rubric for thresholds, and mount `DataProvenanceCard` + `FacetSummaryCard`.

**Files:**
- Modify: `apps/web/src/components/evaluator/ReportDetail.tsx`
- Test: `apps/web/tests/components/evaluator/ReportDetail.test.tsx`

**Interfaces:**
- Consumes: shared `SectionRow`, `SectionResult` (Task 3); `DataProvenanceCard` (Task 4); existing `FacetSummaryCard`; existing `trpc.rubrics.get`.
- Produces: nothing downstream.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/lib/trpc/client", () => ({
  trpc: {
    reports: {
      getUser: { useQuery: vi.fn() },
      rerun: { useMutation: vi.fn(() => ({ mutate: vi.fn(), isPending: false })) },
      facetSummary: { useQuery: vi.fn(() => ({ data: null, isLoading: false, error: null })) },
    },
    rubrics: { get: { useQuery: vi.fn() } },
  },
}));
vi.mock("@/components/RequirePerm", () => ({ RequirePerm: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { ReportDetail } from "@/components/evaluator/ReportDetail";
import { trpc } from "@/lib/trpc/client";

const getUser = trpc.reports.getUser.useQuery as unknown as ReturnType<typeof vi.fn>;
const rubricGet = trpc.rubrics.get.useQuery as unknown as ReturnType<typeof vi.fn>;

const report = {
  totalScore: "112.0",
  periodStart: "2026-07-06T00:00:00.000Z",
  rubricId: "rub-1",
  sectionScores: [
    { sectionId: "interaction", name: "Interaction", weight: 50, standardScore: 100, superiorScore: 120, score: 100, label: "Standard", signals: [{ id: "kw", type: "keyword", hit: false }] },
  ],
  sourceBreakdown: { gateway_events: 0, transcript_events: 1823 },
  dataQuality: { coverageRatio: 0.87, capturedRequests: 100 },
  signalsSummary: { period: { requestCount: 115, bodyCount: 100 } },
  llmNarrative: null,
  llmModel: null,
  llmCalledAt: null,
};

describe("ReportDetail", () => {
  beforeEach(() => {
    getUser.mockReset();
    rubricGet.mockReset();
  });

  it("renders score, provenance card, and a missed signal with threshold", () => {
    getUser.mockReturnValue({ data: [report], isLoading: false, error: null });
    rubricGet.mockReturnValue({
      data: { definition: { sections: [{ id: "interaction", signals: [{ id: "kw", type: "keyword", minRatio: 0.5 }] }] } },
      isLoading: false,
      error: null,
    });
    render(<ReportDetail orgId="org-1" userId="u-1" userName="Steve" />);
    expect(screen.getByText("112.0")).toBeInTheDocument();
    expect(screen.getByText(/Data provenance/i)).toBeInTheDocument();
    expect(screen.getByText(/1823/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @caliber/web test tests/components/evaluator/ReportDetail.test.tsx`
Expected: FAIL — `trpc.rubrics.get` not called / provenance card absent.

- [ ] **Step 3: Edit `ReportDetail.tsx`**

Delete the inline block lines 22-127 (the local `EvidenceItem`/`SignalHit`/`SectionResult` interfaces, `scoreColorClass`, `scoreBadgeClass`, and the local `SectionRow`). Replace the imports (lines 17-20) with shared ones:

```tsx
import { TrendChart } from "./TrendChart";
import type { ScorePoint } from "./TrendChart";
import { SectionRow, scoreBadgeClass, type SectionResult } from "./reportDetailShared";
import { DataProvenanceCard } from "./DataProvenanceCard";
import { FacetSummaryCard } from "./FacetSummaryCard";
import type { RubricSignal } from "./rubricThreshold";
```

After the `rerunMutation` block (line 164) and BEFORE any early return, add the rubric query keyed on the latest report's rubric id (hooks must stay unconditional):

```tsx
const latestRubricId = reports?.[0]?.rubricId ?? null;
const { data: rubric } = trpc.rubrics.get.useQuery(
  { rubricId: latestRubricId ?? "" },
  { enabled: !!latestRubricId },
);
```

After `const sectionScores` is derived (line 225), build the rubric section map + provenance fields:

```tsx
const rubricSectionsById: Record<string, { signals: RubricSignal[] }> = {};
const def = rubric?.definition as { sections?: Array<{ id: string; signals: RubricSignal[] }> } | undefined;
for (const s of def?.sections ?? []) {
  rubricSectionsById[s.id] = { signals: s.signals };
}
const period = (latest.signalsSummary as { period?: { requestCount?: number; bodyCount?: number } } | null)?.period ?? null;
```

Change the section-map render (line 318-320) to pass the rubric section:

```tsx
{sectionScores.map((section) => (
  <SectionRow
    key={section.sectionId}
    section={section}
    rubricSection={rubricSectionsById[section.sectionId]}
  />
))}
```

Insert the provenance + facet cards immediately BEFORE the closing `</div>` of the top-level return (after the section-scores `Card`, line 325):

```tsx
      <DataProvenanceCard
        sourceBreakdown={latest.sourceBreakdown as never}
        dataQuality={latest.dataQuality as never}
        period={period}
      />

      <FacetSummaryCard
        orgId={orgId}
        userId={userId}
        rangeFrom={rangeFrom}
        rangeTo={rangeTo}
      />
```

- [ ] **Step 4: Run tests + full evaluator web suite**

Run: `pnpm --filter @caliber/web test tests/components/evaluator/ReportDetail.test.tsx`
Expected: PASS.
Run: `pnpm --filter @caliber/web test tests/components/evaluator`
Expected: PASS (no regression across evaluator components).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/evaluator/ReportDetail.tsx apps/web/tests/components/evaluator/ReportDetail.test.tsx
git commit -m "feat(web): member report shows signal breakdown, provenance, facet drill-down"
```

---

### Task 6: Parity for ProfileEvaluation (own view)

`ProfileEvaluation` already renders shared `SectionRow` + `FacetSummaryCard`. Add the same rubric-threshold pass-through and mount `DataProvenanceCard` so the user's own view matches the admin view.

**Files:**
- Modify: `apps/web/src/components/evaluator/ProfileEvaluation.tsx`
- Test: extend `apps/web/tests/components/evaluator/ProfileEvaluation.test.tsx` (create if absent, same mock pattern as Task 5 but for the own-scope queries this component uses — inspect its existing `trpc.*` calls first).

**Interfaces:**
- Consumes: `DataProvenanceCard` (Task 4), `RubricSignal` (Task 1), shared `SectionRow` (Task 3).
- Produces: nothing.

- [ ] **Step 1: Read the component to find its report + rubric query names**

Run: `sed -n '1,60p' apps/web/src/components/evaluator/ProfileEvaluation.tsx`
Note which query returns the report row (e.g. `reports.getOwnRange` / `getOwnLatest`) and whether a rubric is already fetched.

- [ ] **Step 2: Write the failing test**

Mirror Task 5's mock-before-import structure, but mock the queries `ProfileEvaluation` actually uses (from Step 1). Assert `getByText(/Data provenance/i)` appears and a missed signal's threshold renders. Expected: FAIL initially.

- [ ] **Step 3: Edit `ProfileEvaluation.tsx`**

- Add `import { DataProvenanceCard } from "./DataProvenanceCard";` and `import type { RubricSignal } from "./rubricThreshold";`.
- If a rubric isn't already fetched, add `trpc.rubrics.get.useQuery({ rubricId: latestRubricId ?? "" }, { enabled: !!latestRubricId })` (same unconditional-hook placement as Task 5), build `rubricSectionsById`, and pass `rubricSection={rubricSectionsById[section.sectionId]}` into each `SectionRow`.
- Mount `<DataProvenanceCard sourceBreakdown={latest.sourceBreakdown as never} dataQuality={latest.dataQuality as never} period={period} />` next to the existing `FacetSummaryCard`.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @caliber/web test tests/components/evaluator/ProfileEvaluation.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/evaluator/ProfileEvaluation.tsx apps/web/tests/components/evaluator/ProfileEvaluation.test.tsx
git commit -m "feat(web): own profile report reaches parity with admin explainability"
```

---

## Phase 2 — LLM evidence frontend (D-frontend)

### Task 7: LlmEvidenceList component + mount in ReportDetail

`llm_narrative` is already rendered; `llm_evidence` (quote + rationale + requestId) is not. Render it under the narrative card. Access is already gated server-side by `redactLlm` (non-subject/non-admin get `null`), so the component simply renders nothing when the field is null/empty.

**Files:**
- Create: `apps/web/src/components/evaluator/LlmEvidenceList.tsx`
- Test: `apps/web/tests/components/evaluator/LlmEvidenceList.test.tsx`
- Modify: `apps/web/src/components/evaluator/ReportDetail.tsx`
- Modify: `apps/web/messages/*` — `evaluator.llmEvidence.*`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `LlmEvidenceList({ evidence })` where `evidence?: unknown` (defensively parsed to `{ quote; requestId; rationale }[]`). Returns `null` when empty.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { LlmEvidenceList } from "@/components/evaluator/LlmEvidenceList";

it("renders each evidence quote with its rationale and request id", () => {
  render(
    <LlmEvidenceList
      evidence={[
        { quote: "let's refactor this", requestId: "req-9", rationale: "shows iterative refinement" },
      ]}
    />,
  );
  expect(screen.getByText(/let's refactor this/)).toBeInTheDocument();
  expect(screen.getByText(/shows iterative refinement/)).toBeInTheDocument();
  expect(screen.getByText(/req-9/)).toBeInTheDocument();
});

it("returns null when evidence is null (redacted or absent)", () => {
  const { container } = render(<LlmEvidenceList evidence={null} />);
  expect(container.firstChild).toBeNull();
});

it("returns null when evidence is an empty array", () => {
  const { container } = render(<LlmEvidenceList evidence={[]} />);
  expect(container.firstChild).toBeNull();
});

it("ignores malformed entries without crashing", () => {
  render(<LlmEvidenceList evidence={[{ quote: "ok", requestId: "r", rationale: "why" }, { bad: 1 }]} />);
  expect(screen.getByText(/ok/)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @caliber/web test tests/components/evaluator/LlmEvidenceList.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```tsx
// apps/web/src/components/evaluator/LlmEvidenceList.tsx
"use client";

import { useTranslations } from "next-intl";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface LlmEvidence {
  quote: string;
  requestId: string;
  rationale: string;
}

function parse(evidence: unknown): LlmEvidence[] {
  if (!Array.isArray(evidence)) return [];
  return evidence.filter(
    (e): e is LlmEvidence =>
      !!e &&
      typeof (e as LlmEvidence).quote === "string" &&
      typeof (e as LlmEvidence).rationale === "string" &&
      typeof (e as LlmEvidence).requestId === "string",
  );
}

export function LlmEvidenceList({ evidence }: { evidence?: unknown }) {
  const t = useTranslations("evaluator.llmEvidence");
  const items = parse(evidence);
  if (items.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-semibold">{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {items.map((ev, idx) => (
          <div key={idx} className="rounded-md border border-border bg-muted/20 px-3 py-2 space-y-1">
            <blockquote className="text-xs italic text-foreground leading-relaxed">
              &ldquo;{ev.quote}&rdquo;
            </blockquote>
            <p className="text-xs text-muted-foreground">{ev.rationale}</p>
            <p className="font-mono text-[10px] text-muted-foreground">
              {t("requestId")} <span className="select-all">{ev.requestId}</span>
            </p>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 4: Add i18n keys**

Add to `en.json` (mirror into 5 locales):

```json
"llmEvidence": {
  "title": "AI evidence",
  "requestId": "Request:"
}
```

- [ ] **Step 5: Mount in ReportDetail**

In `apps/web/src/components/evaluator/ReportDetail.tsx`, add the import `import { LlmEvidenceList } from "./LlmEvidenceList";` and render it right after the narrative card block (after line 296, the `{hasLlmNarrative && (...)}` block):

```tsx
      <LlmEvidenceList evidence={latest.llmEvidence} />
```

- [ ] **Step 6: Run tests + parity**

Run: `pnpm --filter @caliber/web test tests/components/evaluator/LlmEvidenceList.test.tsx`
Expected: PASS (4 tests).
Run: `pnpm --filter @caliber/web test tests/lib/i18n/messagesParity.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/evaluator/LlmEvidenceList.tsx apps/web/tests/components/evaluator/LlmEvidenceList.test.tsx apps/web/src/components/evaluator/ReportDetail.tsx apps/web/messages
git commit -m "feat(web): render LLM evidence (quote + rationale) on report"
```

---

## Phase 3 — Provision wiring (D-backend, api)

### Task 8: Provision the eval key on llmEvalEnabled first-enable

`setSettings` currently only `db.update`s the org row. Without provisioning, enabling `llmEvalEnabled` never creates the Redis eval key, so `runLlm` hits `missing_key` and the narrative stays null forever. Call `provisionLlmEvalKey` on the false→true transition. `provisionLlmEvalKey` is idempotent, so a re-enable is safe.

**Files:**
- Modify: `apps/api/src/trpc/routers/contentCapture.ts`
- Create: `apps/api/tests/integration/trpc/contentCaptureProvision.test.ts`

**Interfaces:**
- Consumes: existing `provisionLlmEvalKey({ db, redis, orgId, apiKeyHashPepper }) => { created, keyId, systemUserId, redisSecretKey }` from `apps/api/src/services/llmEvalKeyProvisioning.ts`.
- Produces: no new exported surface (behavioural change to `setSettings`).

- [ ] **Step 1: Confirm the tRPC context exposes redis + pepper**

Run: `grep -nE "redis|API_KEY_HASH_PEPPER" apps/api/src/trpc/context.ts`
Expected: `ctx.redis` (an ioredis instance) and `ctx.env.API_KEY_HASH_PEPPER` are present. If `ctx.redis` is absent, STOP — thread a redis instance through the context first (out of scope here; flag to the reviewer). The existing `llmEvalKeyProvisioning` integration test injects a `RedisMock`, so the service is redis-agnostic; the router just needs an instance.

- [ ] **Step 2: Write the failing integration test**

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import RedisMock from "ioredis-mock";
import { eq } from "drizzle-orm";
import { apiKeys } from "@caliber/db";
import { makeTestDb, makeOrg, callerFor } from "../../factories"; // adjust to actual factory exports
import { defaultTestEnv } from "../../factories/env"; // adjust import to where API_KEY_HASH_PEPPER lives

// NOTE: mirror the exact factory wiring used by
// apps/api/tests/integration/trpc/contentCapture.test.ts. The one change is
// that callerFor must receive THIS RedisMock instance (its 5th arg) so we can
// assert the provisioned key landed in it.

describe("setSettings provisions the eval key", () => {
  let t: Awaited<ReturnType<typeof makeTestDb>>;
  let redis: RedisMock;

  beforeAll(async () => { t = await makeTestDb(); }, 90_000);
  afterAll(async () => { await t.teardown(); });
  beforeEach(() => { redis = new RedisMock({ keyPrefix: "caliber:gw:" }); });

  it("creates the Redis eval key on false→true, idempotent on re-enable", async () => {
    const org = await makeOrg(t.db);
    const caller = callerFor(t.db, /* admin user */ org.adminUserId, org.id, redis);

    await caller.contentCapture.setSettings({
      orgId: org.id,
      patch: { llmEvalEnabled: true, llmEvalModel: "claude-haiku-4-5" },
    });

    const raw = await redis.get(`llm-eval-key:${org.id}`);
    expect(raw).toMatch(/^caliber-eval-[0-9a-f]{64}$/);

    const keyRows = await t.db.select().from(apiKeys).where(eq(apiKeys.orgId, org.id));
    const evalKey = keyRows.find((k) => k.status === "active" && k.keyPrefix === "caliber-eval");
    expect(evalKey).toBeDefined();

    // Re-enable (true→true, not a transition) must NOT rotate the key.
    await caller.contentCapture.setSettings({ orgId: org.id, patch: { llmEvalModel: "claude-sonnet-5" } });
    const rawAfter = await redis.get(`llm-eval-key:${org.id}`);
    expect(rawAfter).toBe(raw);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @caliber/api test:integration contentCaptureProvision`
Expected: FAIL — Redis key `llm-eval-key:<org>` is null (provision not wired).

- [ ] **Step 4: Edit `contentCapture.ts`**

Add the import at the top:

```ts
import { provisionLlmEvalKey } from "../../services/llmEvalKeyProvisioning.js";
```

Compute the eval transition next to the existing `turningOn` (after line 139):

```ts
const turningOnEval =
  input.patch.llmEvalEnabled === true && prev.llmEvalEnabled === false;
```

After the `db.update(organizations)` call (after line 156) and before the content-capture audit block, provision the key on transition:

```ts
if (turningOnEval) {
  await provisionLlmEvalKey({
    db: ctx.db,
    redis: ctx.redis,
    orgId: input.orgId,
    apiKeyHashPepper: ctx.env.API_KEY_HASH_PEPPER,
  });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @caliber/api test:integration contentCaptureProvision`
Expected: PASS.
Run: `pnpm --filter @caliber/api test:integration contentCapture`
Expected: PASS (existing setSettings tests unaffected).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/trpc/routers/contentCapture.ts apps/api/tests/integration/trpc/contentCaptureProvision.test.ts
git commit -m "feat(api): provision eval key when llmEvalEnabled turns on"
```

---

## Phase 4 — Account-pin (D-backend, gateway)

The scheduler already has a forced-account bypass (`ScheduleRequest.stickyAccountId` → `layer: "forced"`, with `loadSchedulableAccount` re-validating org/team/platform/ownership). We only need to (9) let the failover loop forward a pin, (10) read the pin from an internal header ONLY when the caller holds an eval key, (11) make `runLlm` send that header for the configured account, and (12) prove it end-to-end.

### Task 9: Forward stickyAccountId through the failover loop

**Files:**
- Modify: `apps/gateway/src/runtime/failoverLoop.ts`
- Test: `apps/gateway/tests/runtime/failoverLoop.test.ts` (extend; if absent, create following the nearest existing `tests/runtime/*.test.ts` pattern)

**Interfaces:**
- Consumes: existing `ScheduleRequest.stickyAccountId` (scheduler).
- Produces: `RunFailoverInput` gains `stickyAccountId?: string`; it is forwarded into every `scheduleReq`. Task 10 sets it via `buildFailoverInput`.

- [ ] **Step 1: Write the failing test (capture what the scheduler receives)**

```ts
import { describe, it, expect, vi } from "vitest";
import { runFailover } from "@/runtime/failoverLoop";
// Reuse the minimal RunFailoverInput builder from the existing failover tests;
// if none exists, construct the smallest input the loop needs (db unused on the
// happy path because attempt() short-circuits after the first select).

it("forwards stickyAccountId into the schedule request", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const scheduler = {
    select: vi.fn(async (req: Record<string, unknown>) => {
      seen.push(req);
      return {
        account: { id: "acct-pinned", concurrency: 10, platform: "anthropic", type: "api_key", priority: 50, groupId: null },
        decision: { layer: "forced" },
        release: async () => {},
      };
    }),
    reportResult: vi.fn(),
    reportSwitch: vi.fn(),
    snapshotRuntimeStats: vi.fn(),
  };

  await runFailover({
    db: {} as never,
    orgId: "org-1",
    teamId: null,
    groupId: null,
    routingPolicy: "own_then_pool",
    userId: null,
    platform: "anthropic",
    authHealth: undefined,
    maxSwitches: 1,
    scheduler: scheduler as never,
    stickyAccountId: "acct-pinned",
    attempt: async () => ({ ok: true, value: "done" } as never),
  } as never);

  expect(seen[0]?.stickyAccountId).toBe("acct-pinned");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @caliber/gateway exec vitest run tests/runtime/failoverLoop.test.ts`
Expected: FAIL — `seen[0].stickyAccountId` is `undefined` (not forwarded).

- [ ] **Step 3: Edit `failoverLoop.ts`**

Add the field to `RunFailoverInput` (near the `sessionHash` field ~line 162):

```ts
  /** Forces a specific account (bypasses the 3 sticky/EWMA layers). Used by
   *  the evaluator loopback to pin its calls to the org's eval account. */
  stickyAccountId?: string;
```

Add it to the `scheduleReq` object (the block at ~line 218-229), right after `sessionHash`:

```ts
    sessionHash: input.sessionHash,
    stickyAccountId: input.stickyAccountId,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @caliber/gateway exec vitest run tests/runtime/failoverLoop.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/runtime/failoverLoop.ts apps/gateway/tests/runtime/failoverLoop.test.ts
git commit -m "feat(gateway): forward stickyAccountId through failover loop"
```

---

### Task 10: Eval pin header reader (trust-gated) + route wiring

Read `x-caliber-eval-account-id` ONLY when the request's api key is an eval key (`req.apiKey.keyPrefix === "caliber-eval"`). Eval keys' raw values live only in Redis (gateway-internal), so an external client cannot both hold an eval key AND forge the header — the prefix check is a sufficient trust gate. A non-eval key that forges the header is ignored.

**Files:**
- Create: `apps/gateway/src/runtime/evalAccountPin.ts`
- Test: `apps/gateway/tests/runtime/evalAccountPin.test.ts`
- Modify: the anthropic `/v1/messages` handler in `apps/gateway/src/routes/messages.ts` (the same call site that passes `sessionHash` into `buildFailoverInput`, ~line 365)

**Interfaces:**
- Consumes: `req.apiKey.keyPrefix` (from `apiKeyAuth`), request headers.
- Produces: `evalAccountPin(req: { apiKey?: { keyPrefix?: string }; headers: Record<string, string | string[] | undefined> }): string | undefined`. Task's route change passes it as `stickyAccountId`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { evalAccountPin } from "@/runtime/evalAccountPin";

const acct = "11111111-1111-1111-1111-111111111111";

it("returns the pin when the caller holds an eval key", () => {
  expect(
    evalAccountPin({ apiKey: { keyPrefix: "caliber-eval" }, headers: { "x-caliber-eval-account-id": acct } }),
  ).toBe(acct);
});

it("ignores the header for a normal (non-eval) key — anti-forgery", () => {
  expect(
    evalAccountPin({ apiKey: { keyPrefix: "ak_1234" }, headers: { "x-caliber-eval-account-id": acct } }),
  ).toBeUndefined();
});

it("returns undefined when the header is absent", () => {
  expect(evalAccountPin({ apiKey: { keyPrefix: "caliber-eval" }, headers: {} })).toBeUndefined();
});

it("handles array-valued headers (takes the first)", () => {
  expect(
    evalAccountPin({ apiKey: { keyPrefix: "caliber-eval" }, headers: { "x-caliber-eval-account-id": [acct, "x"] } }),
  ).toBe(acct);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @caliber/gateway exec vitest run tests/runtime/evalAccountPin.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/gateway/src/runtime/evalAccountPin.ts
// Reads the internal eval account-pin header, but ONLY trusts it when the
// request authenticated with an eval key (keyPrefix "caliber-eval"). Eval keys'
// raw values exist only in gateway-internal Redis, so an external client
// cannot hold one — making the prefix a sufficient anti-forgery gate.

const EVAL_PIN_HEADER = "x-caliber-eval-account-id";
const EVAL_KEY_PREFIX = "caliber-eval";

export function evalAccountPin(req: {
  apiKey?: { keyPrefix?: string };
  headers: Record<string, string | string[] | undefined>;
}): string | undefined {
  if (req.apiKey?.keyPrefix !== EVAL_KEY_PREFIX) return undefined;
  const raw = req.headers[EVAL_PIN_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value || undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @caliber/gateway exec vitest run tests/runtime/evalAccountPin.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire into the messages route**

In `apps/gateway/src/routes/messages.ts`, add the import (near the `sessionHashFromHeaders` import, line 27):

```ts
import { evalAccountPin } from "../runtime/evalAccountPin.js";
```

At EACH `buildFailoverInput(req, app.db, { ... })` call site that already passes `sessionHash: sessionHashFromHeaders(req.headers)` (non-stream ~line 365 and the streaming call sites), add:

```ts
      stickyAccountId: evalAccountPin(req),
```

- [ ] **Step 6: Typecheck + existing route tests**

Run: `pnpm --filter @caliber/gateway exec tsc --noEmit`
Expected: no errors.
Run: `pnpm --filter @caliber/gateway exec vitest run tests/routes/messages.integration.test.ts`
Expected: PASS (no regression; pin is undefined for the normal-key tests → behaviour unchanged).

- [ ] **Step 7: Commit**

```bash
git add apps/gateway/src/runtime/evalAccountPin.ts apps/gateway/tests/runtime/evalAccountPin.test.ts apps/gateway/src/routes/messages.ts
git commit -m "feat(gateway): trust-gated eval account-pin header on messages route"
```

---

### Task 11: runLlm reads llmEvalAccountId and sends the pin header

**Files:**
- Modify: `apps/gateway/src/workers/evaluator/runLlm.ts`
- Test: `apps/gateway/tests/workers/evaluator/runLlm.integration.test.ts` (extend) — assert the loopback fetch carries `x-caliber-eval-account-id` when the org has one set, and omits it when null.

**Interfaces:**
- Consumes: `organizations.llmEvalAccountId` column.
- Produces: no new exported surface (the loopback request gains a conditional header).

- [ ] **Step 1: Write the failing test**

Follow the existing `runLlm.integration.test.ts` setup (it already stubs a `fetchFn` / loopback). Add a case: seed the org with `llmEvalAccountId = <uuid>` and a captured `fetchFn`, then assert:

```ts
// after invoking runLlmDeepAnalysis with a captured fetchFn:
const [, init] = fetchSpy.mock.calls[0]!;
expect((init!.headers as Record<string, string>)["x-caliber-eval-account-id"]).toBe(evalAccountId);

// and a second case with llmEvalAccountId = null:
expect((init2!.headers as Record<string, string>)["x-caliber-eval-account-id"]).toBeUndefined();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @caliber/gateway exec vitest run tests/workers/evaluator/runLlm.integration.test.ts`
Expected: FAIL — header not present.

- [ ] **Step 3: Edit `runLlm.ts`**

Add `llmEvalAccountId` to the org select (the `.select({...})` at lines 70-88):

```ts
    llmEvalAccountId: organizations.llmEvalAccountId,
```

Build the headers immutably, adding the pin header only when set (replace the inline `headers` object in the fetch at ~lines 106-118):

```ts
const headers: Record<string, string> = {
  Authorization: `Bearer ${rawKey}`,
  "Content-Type": "application/json",
  "anthropic-version": "2023-06-01",
};
if (orgRow.llmEvalAccountId) {
  headers["x-caliber-eval-account-id"] = orgRow.llmEvalAccountId;
}

res = await fetchFn(url, {
  method: "POST",
  headers,
  body: JSON.stringify(body),
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @caliber/gateway exec vitest run tests/workers/evaluator/runLlm.integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/workers/evaluator/runLlm.ts apps/gateway/tests/workers/evaluator/runLlm.integration.test.ts
git commit -m "feat(gateway): runLlm pins eval calls to llmEvalAccountId via header"
```

---

### Task 12: End-to-end pin proof + anti-forgery

Prove the whole chain: an eval-key request with the pin header lands on the chosen account; a normal-key request that forges the header is ignored (routes normally).

**Files:**
- Extend: `apps/gateway/tests/routes/messages.integration.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 9-11 plus the file's existing `seedOrg`/`seedAccount`/`seedApiKey`/`makeApp`/fake-upstream helpers.

- [ ] **Step 1: Write the failing tests**

Use the file's existing helpers for accounts. ⚠️ CRITICAL for the eval key: the trust gate (Task 10) checks `keyPrefix === "caliber-eval"` (the 12-char prefix real provisioning produces via `rawKey.slice(0,12)`). The file's `seedApiKey` sets `keyPrefix = rawKey.slice(0,8)` = `"caliber-"` for a `caliber-eval-...` raw — which would FAIL the gate and make the pin silently not apply. So seed the eval key with an EXPLICIT `keyPrefix: "caliber-eval"` (insert directly into `apiKeys`, mirroring seedApiKey's columns), not via `seedApiKey`'s default slice. The fake upstream's `lastRequest` records the inbound auth header — assert it corresponds to account B's credential when pinned to B. (Confirm the exact header the upstream receives by copying an existing assertion in this file that inspects `lastRequest`; find the pepper the file already uses for `hashApiKey`.)

```ts
it("eval key + pin header routes to the pinned account", async () => {
  const orgId = await seedOrg();
  const userId = await seedUser(orgId);
  const acctA = await seedAccount(orgId, "cred-A", { name: "A" });
  const acctB = await seedAccount(orgId, "cred-B", { name: "B" });
  const rawEvalKey = `caliber-eval-${"a".repeat(64)}`;
  // Gate checks keyPrefix === "caliber-eval" (12-char). seedApiKey's default
  // slice(0,8) gives "caliber-" and fails the gate → insert with explicit prefix.
  await db.insert(apiKeys).values({
    orgId, userId, keyHash: hashApiKey(pepper, rawEvalKey),
    keyPrefix: "caliber-eval", name: "eval-key",
  });

  const res = await app.inject({
    method: "POST",
    url: "/v1/messages",
    headers: {
      authorization: `Bearer ${rawEvalKey}`,
      "x-caliber-eval-account-id": acctB,
    },
    payload: { model: "claude-3-haiku-20240307", max_tokens: 10 },
  });
  expect(res.statusCode).toBe(200);
  // Assert the upstream call used account B's credential (match the file's
  // existing lastRequest auth assertion style).
  expect(lastRequest!.headers["x-api-key"] ?? lastRequest!.headers["authorization"]).toContain("cred-B");
});

it("normal key forging the pin header is ignored (no crash, routes normally)", async () => {
  const orgId = await seedOrg();
  const userId = await seedUser(orgId);
  await seedAccount(orgId, "cred-A", { name: "A" });
  const rawKey = "ak_normalkey123";
  await seedApiKey(orgId, userId, rawKey); // keyPrefix "ak_norma"

  const res = await app.inject({
    method: "POST",
    url: "/v1/messages",
    headers: {
      authorization: `Bearer ${rawKey}`,
      "x-caliber-eval-account-id": "99999999-9999-9999-9999-999999999999",
    },
    payload: { model: "claude-3-haiku-20240307", max_tokens: 10 },
  });
  expect(res.statusCode).toBe(200); // forged pin ignored → normal routing
});
```

- [ ] **Step 2: Run tests to verify they fail (or the first one does)**

Run: `pnpm --filter @caliber/gateway exec vitest run tests/routes/messages.integration.test.ts -t "pin"`
Expected: the pin test FAILS if any wiring (Tasks 9/10) is off; the anti-forgery test should already pass.

Note: if `seedAccount`'s credential-to-upstream-auth mapping makes the `lastRequest` assertion awkward, fall back to asserting via the slot ZSET the file already uses (`redis.zcard("slots:account:${acctB}")` > 0 during the call) or add a scheduler-level assertion in `tests/runtime/scheduler.integration.test.ts` (which already exercises the `forced` layer). Do NOT leave the pin path without at least one positive end-to-end assertion.

- [ ] **Step 3: Make them pass**

With Tasks 9-11 committed, the pin test passes. If it doesn't, debug the header name casing (Fastify lowercases headers) and the `keyPrefix` value of the seeded eval key.

- [ ] **Step 4: Commit**

```bash
git add apps/gateway/tests/routes/messages.integration.test.ts
git commit -m "test(gateway): end-to-end eval account-pin + anti-forgery"
```

---

## Final verification

- [ ] **Run each package's suite touched by this plan**

```bash
pnpm --filter @caliber/web test
pnpm --filter @caliber/api test:integration
pnpm --filter @caliber/gateway test
pnpm --filter @caliber/web exec tsc --noEmit
pnpm --filter @caliber/api exec tsc --noEmit
pnpm --filter @caliber/gateway exec tsc --noEmit
```

Expected: all green, no type errors.

- [ ] **Manual smoke (post-deploy, operator)** — the runtime gate for LLM narrative is operational, not code:
  1. `/dashboard/organizations/onead/evaluator/settings` → enable `llmEvalEnabled`, set `llmEvalModel = claude-haiku-4-5`, pick the dedicated eval upstream account, budget `degrade`.
  2. Verify Redis has `caliber:gw:llm-eval-key:<orgId>` (provision wiring fired).
  3. `reports.rerun` a member (or wait for next cron); confirm the report now shows narrative + evidence, and that `usage_logs` for the eval call carries the pinned `account_id`.
  4. Confirm A/B/C render immediately for existing reports (no LLM needed): missed signals + thresholds, provenance card, facet drill-down on the admin member page.

## Notes for the implementer

- A/B/C ship value with ZERO operator action — they render from data already in every report. D's narrative requires the operator enable step above.
- Keep `EvidenceRow.tsx` on disk even though nothing imports it after Task 3 (removing it is out of scope; a follow-up cleanup can delete it once confirmed unreferenced).
- The `data-hit` attribute on `SignalBreakdown` rows is load-bearing for tests — don't rename it.
- If `ctx.redis` is missing in the api context (Task 8 Step 1), that is a real blocker — surface it rather than working around it.

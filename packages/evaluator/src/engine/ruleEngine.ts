import type { UsageRow, BodyRow } from "../signals/types.js";
import type { Rubric, Signal } from "../rubric/schema.js";
import { aggregate } from "../metrics/aggregator.js";
import {
  collectKeyword,
  collectThreshold,
  collectRefusalRate,
  collectClientMix,
  collectModelDiversity,
  collectCacheReadRatio,
  collectExtendedThinking,
  collectToolDiversity,
  collectIterationCount,
  collectFacetClaudeHelpfulness,
  collectFacetFrictionPerSession,
  collectFacetBugsCaught,
  collectFacetCodexErrors,
  collectFacetOutcomeSuccessRate,
  collectFacetSessionTypeRatio,
  collectFacetUserSatisfaction,
  extractLatestHumanText,
  type FacetRowInput,
} from "../signals/index.js";
import { scoreSection } from "./sectionScorer.js";
import { scoreSectionContinuous } from "./continuousScorer.js";
import type { SignalHit, DataQuality, Report } from "./types.js";
import type { Metrics } from "../metrics/aggregator.js";
import type { UaBucket } from "../signals/uaBucket.js";

export interface ScoreWithRulesInput {
  rubric: Rubric;
  usageRows: UsageRow[];
  bodyRows: BodyRow[];
  truncatedRequestIds?: Set<string>;
  /**
   * Plan 4C — facet rows for the report window. Optional; when absent, any
   * `facet_*` signal in the rubric falls through to the empty-input branch
   * of its aggregator (gte → hit:false; lte → hit:true). Pass an empty array
   * (or omit) when facet extraction is disabled for the org.
   */
  facetRows?: FacetRowInput[];
}

function bodyToString(body: unknown): string {
  if (body === null || body === undefined) return "";
  if (typeof body === "string") return body;
  return JSON.stringify(body);
}

function dispatchSignal(
  signal: Signal,
  metrics: Metrics,
  usageRows: UsageRow[],
  bodyRows: BodyRow[],
  facetRows: FacetRowInput[],
  noiseFilters: string[],
): SignalHit {
  switch (signal.type) {
    case "keyword": {
      // v2 hygiene (docs/RUBRIC_V2_DESIGN.md §6): request_body/both scan only
      // the latest genuine human turn (via extractLatestHumanText), honoring
      // rubric.noiseFilters, so keyword hits measure this turn — not the
      // accumulated history, system prompt, or tool output.
      type ScanText = { text: string; id: string };
      const scanTexts: ScanText[] = [];
      for (const b of bodyRows) {
        const human = extractLatestHumanText(b.requestBody, noiseFilters);
        if (signal.in === "request_body") {
          if (human !== null) scanTexts.push({ text: human, id: b.requestId });
        } else if (signal.in === "response_body") {
          scanTexts.push({ text: bodyToString(b.responseBody), id: b.requestId });
        } else {
          const resp = bodyToString(b.responseBody);
          scanTexts.push({
            text: human !== null ? `${human} ${resp}` : resp,
            id: b.requestId,
          });
        }
      }

      const allEvidence: NonNullable<SignalHit["evidence"]> = [];
      let bodiesWithHit = 0;
      for (const { text, id } of scanTexts) {
        const result = collectKeyword({
          body: text,
          terms: signal.terms,
          caseSensitive: signal.caseSensitive,
          requestId: id,
        });
        if (result.hit) bodiesWithHit += 1;
        allEvidence.push(...result.evidence);
      }

      // #261: with minRatio, require a fraction of scanned texts to contain a
      // term so high-volume telemetry (a term appearing in a handful of
      // 1000s of bodies) no longer auto-hits. Without it, legacy any-hit is
      // preserved. Bodies excluded from scanTexts (no genuine human text for
      // request_body) do not count toward the denominator.
      const hit =
        signal.minRatio !== undefined
          ? scanTexts.length > 0 &&
            bodiesWithHit / scanTexts.length >= signal.minRatio
          : bodiesWithHit > 0;

      return {
        id: signal.id,
        type: signal.type,
        hit,
        value: allEvidence.length,
        evidence: allEvidence,
        sampleCount: scanTexts.length,
      };
    }

    case "threshold": {
      const value = metrics[signal.metric] as number;
      const result = collectThreshold({
        metricValue: value,
        gte: signal.gte,
        lte: signal.lte,
        between: signal.between,
      });
      return {
        id: signal.id,
        type: signal.type,
        hit: result.hit,
        value: result.value,
        evidence: result.evidence,
        sampleCount: result.sampleCount,
      };
    }

    case "refusal_rate": {
      const result = collectRefusalRate({ bodies: bodyRows, lte: signal.lte });
      return {
        id: signal.id,
        type: signal.type,
        hit: result.hit,
        value: result.value,
        evidence: result.evidence,
        sampleCount: result.sampleCount,
      };
    }

    case "client_mix": {
      const result = collectClientMix({
        bodies: bodyRows,
        expect: signal.expect as UaBucket[],
        minRatio: signal.minRatio,
      });
      return {
        id: signal.id,
        type: signal.type,
        hit: result.hit,
        value: result.value,
        evidence: result.evidence,
        sampleCount: result.sampleCount,
      };
    }

    case "model_diversity": {
      const result = collectModelDiversity({
        usage: usageRows,
        gte: signal.gte,
      });
      return {
        id: signal.id,
        type: signal.type,
        hit: result.hit,
        value: result.value,
        evidence: result.evidence,
        sampleCount: result.sampleCount,
      };
    }

    case "cache_read_ratio": {
      const result = collectCacheReadRatio({
        usage: usageRows,
        gte: signal.gte,
      });
      return {
        id: signal.id,
        type: signal.type,
        hit: result.hit,
        value: result.value,
        evidence: result.evidence,
        sampleCount: result.sampleCount,
      };
    }

    case "extended_thinking_used": {
      const result = collectExtendedThinking({
        bodies: bodyRows,
        minCount: signal.minCount,
      });
      return {
        id: signal.id,
        type: signal.type,
        hit: result.hit,
        value: result.value,
        evidence: result.evidence,
        sampleCount: result.sampleCount,
      };
    }

    case "tool_diversity": {
      const result = collectToolDiversity({
        bodies: bodyRows,
        gte: signal.gte,
      });
      return {
        id: signal.id,
        type: signal.type,
        hit: result.hit,
        value: result.value,
        evidence: result.evidence,
        sampleCount: result.sampleCount,
      };
    }

    case "iteration_count": {
      const result = collectIterationCount({
        bodies: bodyRows,
        gte: signal.gte,
      });
      return {
        id: signal.id,
        type: signal.type,
        hit: result.hit,
        value: result.value,
        evidence: result.evidence,
        sampleCount: result.sampleCount,
      };
    }

    // ── Plan 4C facet-based signals ────────────────────────────────────────
    case "facet_claude_helpfulness": {
      const result = collectFacetClaudeHelpfulness({
        rows: facetRows,
        gte: signal.gte,
      });
      return {
        id: signal.id,
        type: signal.type,
        hit: result.hit,
        value: result.value,
        evidence: result.evidence,
        sampleCount: result.sampleCount,
      };
    }

    case "facet_friction_per_session": {
      const result = collectFacetFrictionPerSession({
        rows: facetRows,
        lte: signal.lte,
      });
      return {
        id: signal.id,
        type: signal.type,
        hit: result.hit,
        value: result.value,
        evidence: result.evidence,
        sampleCount: result.sampleCount,
      };
    }

    case "facet_bugs_caught": {
      const result = collectFacetBugsCaught({
        rows: facetRows,
        gte: signal.gte,
        normalize: signal.normalize,
      });
      return {
        id: signal.id,
        type: signal.type,
        hit: result.hit,
        value: result.value,
        evidence: result.evidence,
        sampleCount: result.sampleCount,
      };
    }

    case "facet_codex_errors": {
      const result = collectFacetCodexErrors({
        rows: facetRows,
        lte: signal.lte,
        normalize: signal.normalize,
      });
      return {
        id: signal.id,
        type: signal.type,
        hit: result.hit,
        value: result.value,
        evidence: result.evidence,
        sampleCount: result.sampleCount,
      };
    }

    case "facet_outcome_success_rate": {
      const result = collectFacetOutcomeSuccessRate({
        rows: facetRows,
        gte: signal.gte,
      });
      return {
        id: signal.id,
        type: signal.type,
        hit: result.hit,
        value: result.value,
        evidence: result.evidence,
        sampleCount: result.sampleCount,
      };
    }

    case "facet_session_type_ratio": {
      const result = collectFacetSessionTypeRatio({
        rows: facetRows,
        targetType: signal.targetType,
        gte: signal.gte,
      });
      return {
        id: signal.id,
        type: signal.type,
        hit: result.hit,
        value: result.value,
        evidence: result.evidence,
        sampleCount: result.sampleCount,
      };
    }

    case "facet_user_satisfaction": {
      const result = collectFacetUserSatisfaction({
        rows: facetRows,
        gte: signal.gte,
      });
      return {
        id: signal.id,
        type: signal.type,
        hit: result.hit,
        value: result.value,
        evidence: result.evidence,
        sampleCount: result.sampleCount,
      };
    }
  }
}

function computeDataQuality(
  usage: UsageRow[],
  bodies: BodyRow[],
  truncatedSet?: Set<string>,
): DataQuality {
  const totalRequests = usage.length;
  const captured = bodies.length;
  const missingBodies = Math.max(0, totalRequests - captured);
  const truncatedBodies = truncatedSet
    ? bodies.filter((b) => truncatedSet.has(b.requestId)).length
    : 0;
  const coverageRatio = totalRequests === 0 ? 0 : captured / totalRequests;
  return {
    capturedRequests: captured,
    missingBodies,
    truncatedBodies,
    totalRequests,
    coverageRatio,
  };
}

export function scoreWithRules(input: ScoreWithRulesInput): Report {
  const { rubric, usageRows, bodyRows, truncatedRequestIds } = input;
  const facetRows: FacetRowInput[] = input.facetRows ?? [];
  const scaleMax = rubric.scale?.max ?? 120;

  const metrics = aggregate({ usageRows, bodyRows });

  const sectionScores = rubric.sections.map((section) => {
    const hits: SignalHit[] = section.signals.map((signal) =>
      dispatchSignal(signal, metrics, usageRows, bodyRows, facetRows, rubric.noiseFilters ?? []),
    );
    return section.scoring?.mode === "continuous"
      ? scoreSectionContinuous(section, hits, scaleMax)
      : scoreSection(section, hits);
  });

  const insufficientData = sectionScores.some((s) => s.score === null);

  let totalScore: number | null = null;
  if (!insufficientData) {
    const totalWeight = sectionScores.reduce((sum, s) => sum + s.weight, 0);
    const weightedSum = sectionScores.reduce(
      (sum, s) => sum + (s.score as number) * s.weight,
      0,
    );
    const rawTotal = totalWeight === 0 ? 0 : weightedSum / totalWeight;
    totalScore = Math.min(scaleMax, Math.max(0, rawTotal));
  }

  const dataQuality = computeDataQuality(
    usageRows,
    bodyRows,
    truncatedRequestIds,
  );

  return { totalScore, insufficientData, sectionScores, signalsSummary: metrics, dataQuality };
}

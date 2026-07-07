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
  type FacetRowInput,
} from "../signals/index.js";
import { scoreSection } from "./sectionScorer.js";
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
): SignalHit {
  switch (signal.type) {
    case "keyword": {
      const texts =
        signal.in === "request_body"
          ? bodyRows.map((b) => ({
              text: bodyToString(b.requestBody),
              id: b.requestId,
            }))
          : signal.in === "response_body"
            ? bodyRows.map((b) => ({
                text: bodyToString(b.responseBody),
                id: b.requestId,
              }))
            : bodyRows.map((b) => ({
                text: `${bodyToString(b.requestBody)} ${bodyToString(b.responseBody)}`,
                id: b.requestId,
              }));

      const allEvidence: NonNullable<SignalHit["evidence"]> = [];
      let bodiesWithHit = 0;

      for (const { text, id } of texts) {
        const result = collectKeyword({
          body: text,
          terms: signal.terms,
          caseSensitive: signal.caseSensitive,
          requestId: id,
        });
        if (result.hit) bodiesWithHit += 1;
        allEvidence.push(...result.evidence);
      }

      // #261: with minRatio, require a fraction of bodies to contain a term so
      // high-volume telemetry (a term appearing in a handful of 1000s of
      // bodies) no longer auto-hits. Without it, legacy any-hit is preserved.
      const hit =
        signal.minRatio !== undefined
          ? texts.length > 0 &&
            bodiesWithHit / texts.length >= signal.minRatio
          : bodiesWithHit > 0;

      return {
        id: signal.id,
        type: signal.type,
        hit,
        value: allEvidence.length,
        evidence: allEvidence,
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
      };
    }

    case "facet_bugs_caught": {
      const result = collectFacetBugsCaught({
        rows: facetRows,
        gte: signal.gte,
      });
      return {
        id: signal.id,
        type: signal.type,
        hit: result.hit,
        value: result.value,
        evidence: result.evidence,
      };
    }

    case "facet_codex_errors": {
      const result = collectFacetCodexErrors({
        rows: facetRows,
        lte: signal.lte,
      });
      return {
        id: signal.id,
        type: signal.type,
        hit: result.hit,
        value: result.value,
        evidence: result.evidence,
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

  const metrics = aggregate({ usageRows, bodyRows });

  const sectionScores = rubric.sections.map((section) => {
    const hits: SignalHit[] = section.signals.map((signal) =>
      dispatchSignal(signal, metrics, usageRows, bodyRows, facetRows),
    );
    return scoreSection(section, hits);
  });

  const totalWeight = sectionScores.reduce((sum, s) => sum + s.weight, 0);
  const weightedSum = sectionScores.reduce(
    (sum, s) => sum + s.score * s.weight,
    0,
  );
  const rawTotal = totalWeight === 0 ? 0 : weightedSum / totalWeight;
  const totalScore = Math.min(120, Math.max(0, rawTotal));

  const dataQuality = computeDataQuality(
    usageRows,
    bodyRows,
    truncatedRequestIds,
  );

  return {
    totalScore,
    sectionScores,
    signalsSummary: metrics,
    dataQuality,
  };
}

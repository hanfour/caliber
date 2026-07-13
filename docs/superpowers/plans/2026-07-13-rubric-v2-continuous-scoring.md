# Rubric v2 連續計分 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓 Caliber evaluator 的 platform 評分從「二檔開關（人人 120）」變成連續分布：新增 continuous section 計分模式、`facet_user_satisfaction` facet、keyword 衛生修復，並 seed platform rubric v2.0.0（先 `is_default=false`，校準後另行翻轉）。

**Architecture:** 規格見 `docs/RUBRIC_V2_DESIGN.md`（已定案）。計分引擎（`packages/evaluator`）新增 continuous scorer：每個 signal 的量測值經 `curve {zeroAt, fullAt}` 線性映射成 0–1 subscore，按 `points` 加權成 section 分（0–120）；樣本不足 → section score = null → 報告 `insufficientData=true`、`totalScore=null`。facet 管線加第 7 個欄位 `userSatisfaction`（prompt version 1→2，cache 自動失效）。keyword signal 改掃「最新真人輸入」並套用 noiseFilters。DB 兩支 migration（facet 欄位、reports 欄位）+ 一支 seed。web 端同步手動鏡像型別與渲染。

**Tech Stack:** TypeScript ESM monorepo（pnpm + turbo）、zod、drizzle-orm（PostgreSQL）、vitest（integration 測試用 testcontainers）、Next.js 15 + React Testing Library。

## Global Constraints

- 分數量表維持 **0–120**，及格線 **108**（`scale: { max: 120, pass: 108 }`）——不是 0–100。
- **所有 schema 新欄位必須 optional**：DB 裡現存的 v1 platform rubric 與 org/key 自訂 rubric 在 9 個 `rubricSchema.parse/safeParse` 呼叫點（見 Task 1 清單）必須繼續 parse 成功，行為 byte-identical。
- Immutability：永遠回傳新物件，不就地 mutate（使用者全域 coding rule）。
- Commit 格式 `<type>: <description>`（feat/fix/refactor/docs/test/chore），**不加** Co-Authored-By 署名（使用者 settings 已停用 attribution）。
- TDD：每個 task 先寫失敗測試再實作。單元測試放各 package 的 `tests/`（鏡射 `src/` 結構）。
- 跑測試：package 內 `pnpm --filter @caliber/evaluator test`（vitest run）；gateway integration 測試需 Docker（testcontainers）。全 repo：root `pnpm test`。
- Migration 編號從 **0029** 開始，比照 0025–0027 附 `_down.sql`。
- `packages/evaluator` 是 build 過的 package（`dist/`）：改 src 後，跨 package 測試前先 `pnpm --filter @caliber/evaluator build`。
- Branch：`feat/rubric-v2-continuous-scoring`（從 main 切）。

## 檔案地圖（先讀這裡再認領 task）

| 區域 | 檔案 |
|---|---|
| rubric schema | `packages/evaluator/src/rubric/schema.ts` |
| 計分引擎 | `packages/evaluator/src/engine/{ruleEngine,sectionScorer,types}.ts`、新 `continuousScorer.ts` |
| facet signal 聚合 | `packages/evaluator/src/signals/facet.ts`、`index.ts` |
| keyword | `packages/evaluator/src/signals/keyword.ts`、新 `humanText.ts` |
| facet 抽取 | `packages/evaluator/src/facet/{parser,promptBuilder,extractor}.ts` |
| v2 rubric 定義 | 新 `packages/evaluator/src/rubrics/platformV2.ts` |
| DB schema | `packages/db/src/schema/{requestBodyFacets,evaluationReports,evaluationReportsByKey}.ts` |
| migrations | `packages/db/drizzle/0029…0031 + _down` |
| gateway worker | `apps/gateway/src/workers/evaluator/{facetWriter,runRuleBased,upsertEvaluationReportByKey,runEvaluation}.ts` |
| API | `apps/api/src/trpc/routers/rubrics.ts`（dryRun L431-514） |
| web 鏡像型別 | `apps/web/src/components/evaluator/{reportDetailShared.tsx,rubricThreshold.ts}` |
| web 渲染 | `ReportDetail.tsx`、`ProfileEvaluation.tsx`、`MemberScoreCell.tsx`、`TeamLeaderboard.tsx`、`TrendChart.tsx`、`DryRunPreview.tsx`、`SignalBreakdown.tsx`、`RubricEditor.tsx` |

---

### Task 1: rubric schema v2 欄位（scale / scoring.mode / points / curve / minSamples / normalize / facet_user_satisfaction）

**Files:**
- Modify: `packages/evaluator/src/rubric/schema.ts`
- Test: `packages/evaluator/tests/rubric/schemaV2.test.ts`（新檔）

**Interfaces:**
- Consumes: 現有 `signalSchema` / `sectionSchema` / `rubricSchema`。
- Produces（後續 task 依賴的確切形狀）:
  - `Rubric.scale?: { max: number; pass?: number }`
  - `Section.scoring?: { mode: "tiered" | "continuous" }`、`Section.minSamples?: number`、`Section.standard/superior` 變 optional（tiered 模式由 superRefine 強制必填）
  - 每個 signal variant 多 `points?: number`、`curve?: { zeroAt: number; fullAt: number }`
  - `facet_bugs_caught` / `facet_codex_errors` 多 `normalize?: "per_session"`
  - 新 signal type `facet_user_satisfaction`：`{ type, id, gte: number(1..5), points?, curve? }`

**背景（rubricSchema 的 9 個呼叫點，全部必須繼續通過）**：`apps/api/src/trpc/routers/rubrics.ts` L204/L278/L462/L579、`apps/api/src/services/resolveReportRubric.ts` L39/L59、`apps/gateway/src/workers/evaluator/rubricResolver.ts` L136/L174/L202/L211/L223、`apps/web/src/components/evaluator/RubricEditor.tsx` L59。只加 optional 欄位 + 新 union variant 就不會破壞它們——測試需驗證。

- [ ] **Step 1: 寫失敗測試**

`packages/evaluator/tests/rubric/schemaV2.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { rubricSchema } from "../../src/rubric/schema.js";

const tier = { score: 100, label: "Standard", criteria: ["c"] };

const legacyRubric = {
  name: "legacy",
  version: "1.0.0",
  locale: "en",
  sections: [
    {
      id: "s1",
      name: "S1",
      weight: "100%",
      standard: tier,
      superior: { ...tier, score: 120, label: "Superior" },
      signals: [{ type: "refusal_rate", id: "rr", lte: 0.2 }],
    },
  ],
};

const continuousSection = {
  id: "eff",
  name: "Efficiency",
  weight: "25%",
  scoring: { mode: "continuous" },
  minSamples: 5,
  signals: [
    {
      type: "facet_claude_helpfulness",
      id: "help",
      gte: 3.5,
      points: 50,
      curve: { zeroAt: 2.5, fullAt: 4.5 },
    },
    {
      type: "facet_user_satisfaction",
      id: "sat",
      gte: 3.5,
      points: 30,
      curve: { zeroAt: 2.5, fullAt: 4.5 },
    },
    {
      type: "facet_bugs_caught",
      id: "bugs",
      gte: 1,
      normalize: "per_session",
      points: 20,
      curve: { zeroAt: 0, fullAt: 0.5 },
    },
  ],
};

describe("rubric schema v2", () => {
  it("still parses a legacy v1 rubric unchanged (backward compat)", () => {
    const parsed = rubricSchema.parse(legacyRubric);
    expect(parsed.sections[0]!.standard!.score).toBe(100);
    expect(parsed.scale).toBeUndefined();
  });

  it("parses scale + a continuous section without standard/superior", () => {
    const parsed = rubricSchema.parse({
      ...legacyRubric,
      scale: { max: 120, pass: 108 },
      sections: [continuousSection],
    });
    expect(parsed.scale).toEqual({ max: 120, pass: 108 });
    expect(parsed.sections[0]!.scoring?.mode).toBe("continuous");
    expect(parsed.sections[0]!.standard).toBeUndefined();
  });

  it("rejects a tiered section missing standard/superior", () => {
    const bad = {
      ...legacyRubric,
      sections: [{ ...legacyRubric.sections[0], standard: undefined, superior: undefined }],
    };
    expect(rubricSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a continuous section whose signal lacks points or curve", () => {
    const bad = {
      ...legacyRubric,
      sections: [
        {
          ...continuousSection,
          signals: [{ type: "refusal_rate", id: "rr", lte: 0.2 }], // 無 points/curve
        },
      ],
    };
    expect(rubricSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a curve where zeroAt === fullAt", () => {
    const bad = {
      ...legacyRubric,
      sections: [
        {
          ...continuousSection,
          signals: [
            {
              type: "facet_claude_helpfulness",
              id: "h",
              gte: 3,
              points: 100,
              curve: { zeroAt: 3, fullAt: 3 },
            },
          ],
        },
      ],
    };
    expect(rubricSchema.safeParse(bad).success).toBe(false);
  });

  it("parses facet_user_satisfaction and bounds gte to 1..5", () => {
    expect(
      rubricSchema.safeParse({
        ...legacyRubric,
        sections: [
          { ...continuousSection, signals: [continuousSection.signals[1]] },
        ],
      }).success,
    ).toBe(true);
    expect(
      rubricSchema.safeParse({
        ...legacyRubric,
        sections: [
          {
            ...continuousSection,
            signals: [
              { type: "facet_user_satisfaction", id: "sat", gte: 6, points: 100, curve: { zeroAt: 2, fullAt: 5 } },
            ],
          },
        ],
      }).success,
    ).toBe(false);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `pnpm --filter @caliber/evaluator exec vitest run tests/rubric/schemaV2.test.ts`
Expected: FAIL（`scale`/`scoring` 欄位 unrecognized 或 standard optional 案例失敗）

- [ ] **Step 3: 實作 schema 變更**

`packages/evaluator/src/rubric/schema.ts` 修改要點（完整程式碼）：

```ts
// 檔案頂部、metricEnum 之後加：
export const curveSchema = z
  .object({ zeroAt: z.number(), fullAt: z.number() })
  .refine((c) => c.zeroAt !== c.fullAt, {
    message: "curve.zeroAt must differ from curve.fullAt",
  });

// 每個 signal variant 共用的 continuous 欄位（以 spread 加進所有 variant 的 shape）：
const continuousFields = {
  points: z.number().positive().optional(),
  curve: curveSchema.optional(),
};
```

`signalSchema` 的**每一個** `z.object({...})` variant 都在 shape 尾端加 `...continuousFields`（keyword、threshold、refusal_rate、client_mix、model_diversity、cache_read_ratio、extended_thinking_used、tool_diversity、iteration_count、六個 facet_*）。另外：

```ts
// facet_bugs_caught 與 facet_codex_errors 兩個 variant 各加：
    normalize: z.enum(["per_session"]).optional(),

// 新 variant（放在 facet_session_type_ratio 之後）：
  z.object({
    type: z.literal("facet_user_satisfaction"),
    id: z.string(),
    gte: z.number().min(1).max(5),
    ...continuousFields,
  }),
```

`sectionSchema` 改為（`standard`/`superior` optional + 新欄位 + superRefine）：

```ts
const tierSchema = z.object({
  score: z.number(),
  label: z.string(),
  criteria: z.array(z.string()),
});

export const sectionSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    weight: z.string().regex(/^\d{1,3}%$/),
    scoring: z.object({ mode: z.enum(["tiered", "continuous"]) }).optional(),
    minSamples: z.number().int().positive().optional(),
    standard: tierSchema.optional(),
    superior: tierSchema.optional(),
    signals: z.array(signalSchema),
    superiorRules: z
      .object({
        strongThresholds: z.array(z.string()),
        supportThresholds: z.array(z.string()),
        minStrongHits: z.number().default(1),
        minSupportHits: z.number().default(1),
      })
      .optional(),
  })
  .superRefine((section, ctx) => {
    const mode = section.scoring?.mode ?? "tiered";
    if (mode === "tiered") {
      if (!section.standard || !section.superior) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "tiered section requires standard and superior tiers",
        });
      }
      return;
    }
    // continuous：每個 signal 必須有 points + curve
    for (const [i, sig] of section.signals.entries()) {
      if (sig.points === undefined || sig.curve === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["signals", i],
          message: "continuous section requires points and curve on every signal",
        });
      }
    }
  });

export const rubricSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  version: z.string(),
  locale: z.enum(["en", "zh-Hant", "ja"]).default("en"),
  scale: z
    .object({ max: z.number().positive(), pass: z.number().positive().optional() })
    .optional(),
  sections: z.array(sectionSchema).min(1),
  noiseFilters: z.array(z.string()).optional(),
});
```

- [ ] **Step 4: 跑測試確認通過 + 既有測試不破**

Run: `pnpm --filter @caliber/evaluator test`
Expected: schemaV2 全 PASS；`tests/rubrics/platform-default.*.test.ts` 與其餘既有測試維持 PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/evaluator/src/rubric/schema.ts packages/evaluator/tests/rubric/schemaV2.test.ts
git commit -m "feat(evaluator): rubric schema v2 — scale, continuous scoring fields, facet_user_satisfaction"
```

---

### Task 2: facet collectors — sampleCount、normalize per_session、collectFacetUserSatisfaction

**Files:**
- Modify: `packages/evaluator/src/signals/facet.ts`、`packages/evaluator/src/signals/types.ts`、`packages/evaluator/src/signals/index.ts`
- Test: `packages/evaluator/tests/signals/facet.test.ts`（追加 describe 區塊）

**Interfaces:**
- Consumes: Task 1 的 schema（僅型別上；collectors 不 import schema）。
- Produces:
  - `SignalResult` 增 `sampleCount?: number`（`signals/types.ts`）
  - `FacetRowInput` 增 `userSatisfaction: number | null`
  - `collectFacetUserSatisfaction(input: { rows: FacetRowInput[]; gte: number }): SignalResult`（mean-gte，同 helpfulness 語意；空 → `hit:false, sampleCount:0`）
  - `collectFacetBugsCaught` / `collectFacetCodexErrors` 增 `normalize?: "per_session"` input 欄位：value = sum ÷ 有值列數
  - 六個既有 facet collector 全部回傳 `sampleCount = present.length`

- [ ] **Step 1: 寫失敗測試**（追加到 `tests/signals/facet.test.ts` 尾端）

```ts
import { collectFacetUserSatisfaction } from "../../src/signals/index.js";

const row = (over: Partial<import("../../src/signals/facet.js").FacetRowInput>) => ({
  sessionType: null,
  outcome: null,
  claudeHelpfulness: null,
  frictionCount: null,
  bugsCaughtCount: null,
  codexErrorsCount: null,
  userSatisfaction: null,
  ...over,
});

describe("sampleCount (v2)", () => {
  it("reports the number of non-null rows", () => {
    const r = collectFacetClaudeHelpfulness({
      rows: [row({ claudeHelpfulness: 4 }), row({}), row({ claudeHelpfulness: 2 })],
      gte: 3,
    });
    expect(r.sampleCount).toBe(2);
  });

  it("is 0 for empty input — including inverted collectors", () => {
    expect(collectFacetFrictionPerSession({ rows: [], lte: 1 }).sampleCount).toBe(0);
    expect(collectFacetCodexErrors({ rows: [], lte: 1 }).sampleCount).toBe(0);
  });
});

describe("normalize per_session (v2)", () => {
  it("bugs_caught: value becomes sum / rows-with-data", () => {
    const r = collectFacetBugsCaught({
      rows: [row({ bugsCaughtCount: 3 }), row({ bugsCaughtCount: 1 }), row({})],
      gte: 1,
      normalize: "per_session",
    });
    expect(r.value).toBe(2); // (3+1)/2
    expect(r.sampleCount).toBe(2);
  });

  it("codex_errors: normalized value keeps lte hit semantics", () => {
    const r = collectFacetCodexErrors({
      rows: [row({ codexErrorsCount: 2 }), row({ codexErrorsCount: 0 })],
      lte: 1.5,
      normalize: "per_session",
    });
    expect(r.value).toBe(1); // (2+0)/2
    expect(r.hit).toBe(true);
  });

  it("without normalize the legacy sum behaviour is unchanged", () => {
    const r = collectFacetBugsCaught({
      rows: [row({ bugsCaughtCount: 3 }), row({ bugsCaughtCount: 1 })],
      gte: 4,
    });
    expect(r.value).toBe(4);
    expect(r.hit).toBe(true);
  });
});

describe("collectFacetUserSatisfaction (v2)", () => {
  it("means non-null values and hits on gte", () => {
    const r = collectFacetUserSatisfaction({
      rows: [row({ userSatisfaction: 5 }), row({ userSatisfaction: 3 }), row({})],
      gte: 4,
    });
    expect(r.value).toBe(4);
    expect(r.hit).toBe(true);
    expect(r.sampleCount).toBe(2);
  });

  it("empty input → hit:false, sampleCount 0", () => {
    const r = collectFacetUserSatisfaction({ rows: [], gte: 3 });
    expect(r.hit).toBe(false);
    expect(r.sampleCount).toBe(0);
  });
});
```

注意：本檔既有測試的 fixture rows 若是手寫物件字面值，會因 `FacetRowInput` 新增 `userSatisfaction` 欄位而 type error——把既有 fixture 統一改用上面的 `row()` helper，或在既有字面值補 `userSatisfaction: null`。

- [ ] **Step 2: 跑測試確認失敗**

Run: `pnpm --filter @caliber/evaluator exec vitest run tests/signals/facet.test.ts`
Expected: FAIL（`collectFacetUserSatisfaction` not exported、`sampleCount` undefined）

- [ ] **Step 3: 實作**

`signals/types.ts` 的 `SignalResult` 加欄位：

```ts
export interface SignalResult {
  hit: boolean;
  value: number;
  evidence: Evidence[];
  /** v2: number of rows that actually carried data for this signal. */
  sampleCount?: number;
}
```

`signals/facet.ts`：

1. `FacetRowInput` 加 `userSatisfaction: number | null;`
2. 六個既有 collector 的 return 全部帶 `sampleCount: present.length`（空輸入分支帶 `sampleCount: 0`）。
3. `SumGteInput`/`SumLteInput` 加 `normalize?: "per_session"`，`collectFacetBugsCaught`/`collectFacetCodexErrors` 計算：

```ts
  const sum = present.reduce((a, b) => a + b, 0);
  const value =
    input.normalize === "per_session" ? sum / present.length : sum;
  return { hit: value >= input.gte, value, evidence: [], sampleCount: present.length };
  // codex_errors 為 lte：hit: value <= input.lte
```

4. 新 collector（放在 `collectFacetOutcomeSuccessRate` 之後，語意與 helpfulness 相同）：

```ts
/**
 * Mean `userSatisfaction` across rows with a numeric value (1-5 scale, v2).
 * `hit: true` when mean >= gte. Empty/all-null → hit:false.
 */
export function collectFacetUserSatisfaction(
  input: MeanGteInput,
): SignalResult {
  const present = input.rows
    .map((r) => r.userSatisfaction)
    .filter((v): v is number => v !== null);

  if (present.length === 0) {
    return { hit: false, value: 0, evidence: [], sampleCount: 0 };
  }

  const mean = present.reduce((a, b) => a + b, 0) / present.length;
  return { hit: mean >= input.gte, value: mean, evidence: [], sampleCount: present.length };
}
```

5. `signals/index.ts` re-export `collectFacetUserSatisfaction`。

- [ ] **Step 4: 跑測試確認通過**

Run: `pnpm --filter @caliber/evaluator test`
Expected: 全 PASS（含既有 facet 測試）。

- [ ] **Step 5: Commit**

```bash
git add packages/evaluator/src/signals/ packages/evaluator/tests/signals/facet.test.ts
git commit -m "feat(evaluator): facet collectors v2 — sampleCount, per_session normalize, user satisfaction"
```

---

### Task 3: continuous section scorer + engine 型別擴充

**Files:**
- Create: `packages/evaluator/src/engine/continuousScorer.ts`
- Modify: `packages/evaluator/src/engine/types.ts`
- Test: `packages/evaluator/tests/engine/continuousScorer.test.ts`（新檔）

**Interfaces:**
- Consumes: Task 1 的 `Section`（`scoring.mode === "continuous"`、signal `points`/`curve`）、Task 2 的 `SignalHit.sampleCount`。
- Produces:
  - `curveScore(value: number, curve: { zeroAt: number; fullAt: number }): number`（0–1，線性 clamp，`zeroAt > fullAt` 自動反向）
  - `scoreSectionContinuous(section: Section, hits: SignalHit[], scaleMax: number): SectionResult`
  - `engine/types.ts` 變更：
    - `SignalHit` 增 `sampleCount?: number; earnedPoints?: number; maxPoints?: number;`
    - `SectionResult` 增 `mode: "tiered" | "continuous"; maxScore?: number;`，`score: number | null;`（tiered 永遠 number）
    - `Report` 變 `totalScore: number | null; insufficientData: boolean;`

**計分規則（引自設計 §4/§4.1，實作以此為準）**：
- facet_* signal「可用」⇔ `sampleCount >= (section.minSamples ?? 5)`；非 facet signal「可用」⇔ `sampleCount === undefined || sampleCount > 0`（usage-metric 類 signal 不設 minSamples 門檻）。
- 可用 signals 的 `points` 重新歸一：section 分 = `scaleMax × Σ(points_i × curveScore(value_i)) / Σ(points_i)`（只計可用者）。
- **可用 points 總和 < 全部 points 總和的一半 → section score = null**（過半證據缺失就不給分）。
- 每個 hit 回填 `earnedPoints`（可用者 = `points × subscore`；不可用者 = undefined）與 `maxPoints = points`。

- [ ] **Step 1: 寫失敗測試**

`packages/evaluator/tests/engine/continuousScorer.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { curveScore, scoreSectionContinuous } from "../../src/engine/continuousScorer.js";
import type { Section } from "../../src/rubric/schema.js";
import type { SignalHit } from "../../src/engine/types.js";

const section: Section = {
  id: "eff",
  name: "Efficiency",
  weight: "25%",
  scoring: { mode: "continuous" },
  signals: [
    { type: "facet_claude_helpfulness", id: "help", gte: 3.5, points: 60, curve: { zeroAt: 2.5, fullAt: 4.5 } },
    { type: "facet_friction_per_session", id: "fric", lte: 1, points: 40, curve: { zeroAt: 3.0, fullAt: 0.5 } },
  ],
} as Section;

const hit = (over: Partial<SignalHit>): SignalHit => ({
  id: "help",
  type: "facet_claude_helpfulness",
  hit: true,
  value: 0,
  ...over,
});

describe("curveScore", () => {
  it("clamps and interpolates ascending curves", () => {
    const c = { zeroAt: 2.5, fullAt: 4.5 };
    expect(curveScore(2.5, c)).toBe(0);
    expect(curveScore(4.5, c)).toBe(1);
    expect(curveScore(3.5, c)).toBeCloseTo(0.5);
    expect(curveScore(1, c)).toBe(0);
    expect(curveScore(5, c)).toBe(1);
  });

  it("handles descending (inverted) curves", () => {
    const c = { zeroAt: 3.0, fullAt: 0.5 };
    expect(curveScore(3.0, c)).toBe(0);
    expect(curveScore(0.5, c)).toBe(1);
    expect(curveScore(1.75, c)).toBeCloseTo(0.5);
    expect(curveScore(10, c)).toBe(0);
    expect(curveScore(0, c)).toBe(1);
  });
});

describe("scoreSectionContinuous", () => {
  it("weights subscores by points onto the 0..scaleMax scale", () => {
    const hits = [
      hit({ id: "help", value: 4.5, sampleCount: 10 }), // subscore 1 → 60 pts
      hit({ id: "fric", type: "facet_friction_per_session", value: 1.75, sampleCount: 10 }), // 0.5 → 20 pts
    ];
    const r = scoreSectionContinuous(section, hits, 120);
    expect(r.mode).toBe("continuous");
    expect(r.score).toBeCloseTo(96); // 120 × (60+20)/100
    expect(r.maxScore).toBe(120);
    expect(r.signals.find((s) => s.id === "help")!.earnedPoints).toBeCloseTo(60);
    expect(r.signals.find((s) => s.id === "fric")!.maxPoints).toBe(40);
  });

  it("redistributes points when a minor signal lacks samples", () => {
    const hits = [
      hit({ id: "help", value: 3.5, sampleCount: 10 }), // 0.5
      hit({ id: "fric", type: "facet_friction_per_session", value: 0, sampleCount: 0 }), // unusable (40 pts < half)
    ];
    const r = scoreSectionContinuous(section, hits, 120);
    expect(r.score).toBeCloseTo(60); // 120 × (60×0.5)/60
  });

  it("returns null score when usable points drop below half", () => {
    const hits = [
      hit({ id: "help", value: 5, sampleCount: 2 }), // 2 < minSamples 5 → unusable (60 pts)
      hit({ id: "fric", type: "facet_friction_per_session", value: 0.5, sampleCount: 10 }),
    ];
    const r = scoreSectionContinuous(section, hits, 120);
    expect(r.score).toBeNull();
  });

  it("respects a custom minSamples", () => {
    const s2 = { ...section, minSamples: 1 } as Section;
    const hits = [
      hit({ id: "help", value: 4.5, sampleCount: 2 }),
      hit({ id: "fric", type: "facet_friction_per_session", value: 0.5, sampleCount: 2 }),
    ];
    expect(scoreSectionContinuous(s2, hits, 120).score).toBeCloseTo(120);
  });

  it("treats non-facet signals as usable whenever they carry any sample", () => {
    const s3 = {
      ...section,
      signals: [
        { type: "cache_read_ratio", id: "cache", gte: 0.2, points: 100, curve: { zeroAt: 0.1, fullAt: 0.6 } },
      ],
    } as Section;
    const r = scoreSectionContinuous(
      s3,
      [hit({ id: "cache", type: "cache_read_ratio", value: 0.35, sampleCount: 3 })],
      120,
    );
    expect(r.score).toBeCloseTo(60); // (0.35-0.1)/(0.5) = 0.5 → 120×0.5
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `pnpm --filter @caliber/evaluator exec vitest run tests/engine/continuousScorer.test.ts`
Expected: FAIL（module 不存在）

- [ ] **Step 3: 實作**

`engine/types.ts`（完整替換相關 interface）：

```ts
export interface SignalHit {
  id: string;
  type: Signal["type"];
  hit: boolean;
  value?: number;
  evidence?: Evidence[];
  /** v2: rows that actually carried data for this signal. */
  sampleCount?: number;
  /** v2 continuous: points earned after curve mapping (undefined when unusable). */
  earnedPoints?: number;
  /** v2 continuous: configured points for this signal. */
  maxPoints?: number;
}

export interface SectionResult {
  sectionId: string;
  name: string;
  weight: number; // Parsed from "50%" → 50
  /** v2: which scorer produced this result. Legacy rows lack the field. */
  mode: "tiered" | "continuous";
  standardScore: number;
  superiorScore: number;
  /** null = insufficient data (continuous only). Tiered is always numeric. */
  score: number | null;
  /** v2 continuous: the scale max this section was scored against. */
  maxScore?: number;
  label: string;
  signals: SignalHit[];
}

export interface Report {
  /** Weighted aggregate on the rubric scale (default [0,120]); null = insufficient data. */
  totalScore: number | null;
  insufficientData: boolean;
  sectionScores: SectionResult[];
  signalsSummary: Metrics;
  dataQuality: DataQuality;
}
```

`engine/continuousScorer.ts`（新檔，完整內容）：

```ts
import type { Section } from "../rubric/schema.js";
import type { SectionResult, SignalHit } from "./types.js";

const DEFAULT_MIN_SAMPLES = 5;

export interface Curve {
  zeroAt: number;
  fullAt: number;
}

/** Linear map value→[0,1]; descending curves (zeroAt > fullAt) invert automatically. */
export function curveScore(value: number, curve: Curve): number {
  const t = (value - curve.zeroAt) / (curve.fullAt - curve.zeroAt);
  return Math.min(1, Math.max(0, t));
}

function parseWeight(w: string): number {
  return Number(w.replace("%", ""));
}

function isFacetSignal(type: SignalHit["type"]): boolean {
  return type.startsWith("facet_");
}

/**
 * Score a continuous-mode section (design: docs/RUBRIC_V2_DESIGN.md §4).
 *
 * - usable facet signal   ⇔ sampleCount >= (section.minSamples ?? 5)
 * - usable non-facet      ⇔ sampleCount undefined or > 0
 * - score = scaleMax × Σ(points×subscore over usable) / Σ(points over usable)
 * - usable points < half of configured points → score: null (insufficient data)
 */
export function scoreSectionContinuous(
  section: Section,
  hits: SignalHit[],
  scaleMax: number,
): SectionResult {
  const byId = new Map(section.signals.map((s) => [s.id, s]));
  const minSamples = section.minSamples ?? DEFAULT_MIN_SAMPLES;

  let totalPoints = 0;
  let usablePoints = 0;
  let earnedSum = 0;

  const annotated: SignalHit[] = hits.map((h) => {
    const sig = byId.get(h.id);
    if (!sig || sig.points === undefined || sig.curve === undefined) return h;

    totalPoints += sig.points;
    const samples = h.sampleCount;
    const usable = isFacetSignal(h.type)
      ? (samples ?? 0) >= minSamples
      : samples === undefined || samples > 0;

    if (!usable) return { ...h, maxPoints: sig.points };

    const subscore = curveScore(h.value ?? 0, sig.curve);
    const earned = sig.points * subscore;
    usablePoints += sig.points;
    earnedSum += earned;
    return { ...h, earnedPoints: earned, maxPoints: sig.points };
  });

  const insufficient = totalPoints === 0 || usablePoints < totalPoints / 2;
  const score = insufficient
    ? null
    : scaleMax * (earnedSum / usablePoints);

  return {
    sectionId: section.id,
    name: section.name,
    weight: parseWeight(section.weight),
    mode: "continuous",
    standardScore: 0,
    superiorScore: scaleMax,
    score,
    maxScore: scaleMax,
    label: insufficient ? "insufficient_data" : "continuous",
    signals: annotated,
  };
}
```

`sectionScorer.ts` 的 `scoreSection` 回傳補上 `mode: "tiered"`（一行）。

- [ ] **Step 4: 跑測試 + typecheck**

Run: `pnpm --filter @caliber/evaluator test && pnpm --filter @caliber/evaluator lint`
Expected: continuousScorer 全 PASS。`ruleEngine.ts` 會因 `Report` 型別變更報 type error → 下一個 task 處理；若 lint 擋 commit，先只跑 vitest 確認，type 修復併入 Task 4 同一個 commit 亦可（此時先不 commit types.ts 的 Report 變更會讓測試難切分——實務上 Task 3+4 可連續完成再各自 commit）。

- [ ] **Step 5: Commit**

```bash
git add packages/evaluator/src/engine/ packages/evaluator/tests/engine/continuousScorer.test.ts
git commit -m "feat(evaluator): continuous section scorer with curve mapping and insufficient-data semantics"
```

---

### Task 4: ruleEngine 整合 — mode 分派、scale、insufficientData、facet_user_satisfaction、noiseFilters 管線

**Files:**
- Modify: `packages/evaluator/src/engine/ruleEngine.ts`
- Test: `packages/evaluator/tests/engine/ruleEngine.test.ts`（追加）

**Interfaces:**
- Consumes: Task 1–3 全部。
- Produces: `scoreWithRules(input)` 新行為 —
  - rubric 有 continuous section → 用 `scoreSectionContinuous`；scale 取 `rubric.scale?.max ?? 120`
  - 任一 section `score === null` → `totalScore: null, insufficientData: true`；否則加權平均（只算全部 sections，行為同現在）並 clamp `[0, scaleMax]`
  - `dispatchSignal` 新 case `facet_user_satisfaction`
  - keyword case 接收 `noiseFilters`（本 task 先把參數傳進來；實際文本抽取邏輯在 Task 5）

- [ ] **Step 1: 寫失敗測試**（追加到 `tests/engine/ruleEngine.test.ts`；沿用該檔既有的 UsageRow/BodyRow fixture helpers——先讀檔頂 helper 命名再對齊）

```ts
const contRubric = {
  name: "v2",
  version: "2.0.0",
  locale: "en" as const,
  scale: { max: 120, pass: 108 },
  sections: [
    {
      id: "sat",
      name: "Satisfaction",
      weight: "100%",
      scoring: { mode: "continuous" as const },
      minSamples: 2,
      signals: [
        {
          type: "facet_user_satisfaction" as const,
          id: "usat",
          gte: 3.5,
          points: 100,
          curve: { zeroAt: 2.5, fullAt: 4.5 },
        },
      ],
    },
  ],
};

const facetRow = (userSatisfaction: number | null) => ({
  sessionType: null, outcome: null, claudeHelpfulness: null,
  frictionCount: null, bugsCaughtCount: null, codexErrorsCount: null,
  userSatisfaction,
});

describe("scoreWithRules v2 continuous", () => {
  it("scores a continuous rubric from facet rows on the 120 scale", () => {
    const report = scoreWithRules({
      rubric: contRubric,
      usageRows: [],
      bodyRows: [],
      facetRows: [facetRow(4.5), facetRow(4.5), facetRow(4.5)],
    });
    expect(report.totalScore).toBeCloseTo(120);
    expect(report.insufficientData).toBe(false);
    expect(report.sectionScores[0]!.mode).toBe("continuous");
  });

  it("yields a mid-scale score for mid-scale inputs (no more all-or-nothing)", () => {
    const report = scoreWithRules({
      rubric: contRubric,
      usageRows: [],
      bodyRows: [],
      facetRows: [facetRow(3.5), facetRow(3.5)],
    });
    expect(report.totalScore).toBeCloseTo(60); // subscore 0.5 → 120×0.5
  });

  it("returns null totalScore + insufficientData when samples are too thin", () => {
    const report = scoreWithRules({
      rubric: contRubric,
      usageRows: [],
      bodyRows: [],
      facetRows: [facetRow(5)], // 1 < minSamples 2
    });
    expect(report.totalScore).toBeNull();
    expect(report.insufficientData).toBe(true);
  });

  it("keeps legacy tiered rubrics working (insufficientData always false)", () => {
    const tieredRubric = {
      name: "v1", version: "1.0.0", locale: "en" as const,
      sections: [{
        id: "risk", name: "Risk", weight: "100%",
        standard: { score: 100, label: "Std", criteria: [] },
        superior: { score: 120, label: "Sup", criteria: [] },
        signals: [{ type: "refusal_rate" as const, id: "rr", lte: 0.2 }],
      }],
    };
    const report = scoreWithRules({ rubric: tieredRubric, usageRows: [], bodyRows: [] });
    expect(report.totalScore).toBe(120); // 空 bodies → refusal hit:true → 全 signal 命中 → superior（既有 v1 行為）
    expect(report.insufficientData).toBe(false);
    expect(report.sectionScores[0]!.mode).toBe("tiered");
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `pnpm --filter @caliber/evaluator exec vitest run tests/engine/ruleEngine.test.ts`
Expected: FAIL（facet_user_satisfaction case 不存在 → dispatchSignal switch 落空 / totalScore 型別）

- [ ] **Step 3: 實作 ruleEngine 變更**

1. import 加 `collectFacetUserSatisfaction`、`scoreSectionContinuous`。
2. `dispatchSignal` 新 case（比照 helpfulness）：

```ts
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
```

3. **所有既有 case 的 return 都補 `sampleCount: result.sampleCount`**（collectors 沒回傳時為 undefined，無害）。keyword case 額外帶 `sampleCount: texts.length`。
4. `scoreWithRules` 主體改為：

```ts
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

  const dataQuality = computeDataQuality(usageRows, bodyRows, truncatedRequestIds);

  return { totalScore, insufficientData, sectionScores, signalsSummary: metrics, dataQuality };
}
```

5. `dispatchSignal` 簽名加最後參數 `noiseFilters: string[]`（keyword case 先原樣不用；Task 5 接上）。

- [ ] **Step 4: 跑 package 全測試**

Run: `pnpm --filter @caliber/evaluator test && pnpm --filter @caliber/evaluator build`
Expected: 全 PASS + build 成功。**注意**：`tests/rubrics/platform-default.*.test.ts` 若斷言 `report.totalScore` 型別/數值，補 `insufficientData: false` 相關斷言即可，數值不得變。

- [ ] **Step 5: Commit**

```bash
git add packages/evaluator/src/engine/ packages/evaluator/tests/engine/ruleEngine.test.ts
git commit -m "feat(evaluator): wire continuous scoring, scale, insufficientData and user-satisfaction signal into rule engine"
```

---

### Task 5: keyword 衛生修復 — 只掃最新真人輸入 + 套用 noiseFilters

**Files:**
- Create: `packages/evaluator/src/signals/humanText.ts`
- Modify: `packages/evaluator/src/engine/ruleEngine.ts`（keyword case）、`packages/evaluator/src/signals/index.ts`
- Test: `packages/evaluator/tests/signals/humanText.test.ts`（新檔）、`packages/evaluator/tests/engine/ruleEngine.test.ts`（追加）

**Interfaces:**
- Consumes: BodyRow.requestBody 的兩種形狀 —— gateway 原始 `/v1/messages` body（`{ system?, messages: [...] }`，歷史滾雪球）與 transcript 合成 body（`{ model, messages: [...填充空 user..., { role:"user", content: blocks }] }`，見 `packages/evaluator/src/telemetry/transcriptRows.ts` L76-90）。
- Produces: `extractLatestHumanText(requestBody: unknown, noiseFilters: string[]): string | null`
  - 取 `messages` 陣列**最後一個** `role === "user"` 的 entry；content 為 string 直接用；content 為陣列時只取 `type === "text"` 的 block（**跳過 `tool_result`**）。
  - 含任一 noiseFilter 子字串（不分大小寫）的 text block 整塊剔除。
  - 沒有真人文字（如最後一則 user 是純 tool_result）→ 回 `null`。
- ruleEngine keyword case 新語意：
  - `in: "request_body"` → 掃 `extractLatestHumanText(...)`；`null` 的 body **不進 minRatio 分母**。
  - `in: "both"` → 真人文字 + `bodyToString(b.responseBody)` 串接；真人文字為 null 時只掃 response。
  - `in: "response_body"` → 不變。

- [ ] **Step 1: 寫失敗測試**

`packages/evaluator/tests/signals/humanText.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { extractLatestHumanText } from "../../src/signals/humanText.js";

const NOISE = ["<system-reminder>", "<command-name>"];

describe("extractLatestHumanText", () => {
  it("takes only the LAST user message (no history snowball)", () => {
    const body = {
      system: "you like to refactor",
      messages: [
        { role: "user", content: [{ type: "text", text: "please refactor this" }] },
        { role: "assistant", content: [{ type: "text", text: "done" }] },
        { role: "user", content: [{ type: "text", text: "now add tests" }] },
      ],
    };
    expect(extractLatestHumanText(body, [])).toBe("now add tests");
  });

  it("returns null when the last user message is pure tool_result", () => {
    const body = {
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Bash", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "refactor optimize" }] },
      ],
    };
    expect(extractLatestHumanText(body, [])).toBeNull();
  });

  it("drops text blocks containing a noise marker (case-insensitive)", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "<System-Reminder> injected refactor noise" },
            { type: "text", text: "real question" },
          ],
        },
      ],
    };
    expect(extractLatestHumanText(body, NOISE)).toBe("real question");
  });

  it("supports plain-string content and transcript-shaped bodies", () => {
    expect(
      extractLatestHumanText({ messages: [{ role: "user", content: "try another approach" }] }, []),
    ).toBe("try another approach");
    const tx = {
      model: "unknown",
      messages: [
        { role: "user", content: "" },
        { role: "user", content: [{ type: "text", text: "比較兩個方案" }] },
      ],
    };
    expect(extractLatestHumanText(tx, [])).toBe("比較兩個方案");
  });

  it("returns null for malformed bodies", () => {
    expect(extractLatestHumanText(null, [])).toBeNull();
    expect(extractLatestHumanText("raw", [])).toBeNull();
    expect(extractLatestHumanText({ messages: "x" }, [])).toBeNull();
  });
});
```

`tests/engine/ruleEngine.test.ts` 追加（用檔內既有 BodyRow fixture helper 的欄位形狀）：

```ts
describe("keyword v2 — latest-human-turn scanning", () => {
  const kwRubric = {
    name: "kw", version: "1.0.0", locale: "en" as const,
    sections: [{
      id: "s", name: "S", weight: "100%",
      standard: { score: 100, label: "Std", criteria: [] },
      superior: { score: 120, label: "Sup", criteria: [] },
      signals: [{
        type: "keyword" as const, id: "kw", in: "request_body" as const,
        terms: ["refactor"], caseSensitive: false, minRatio: 0.5,
      }],
    }],
  };

  const bodyWith = (requestId: string, messages: unknown[]) => ({
    requestId, stopReason: null, clientUserAgent: null, clientSessionId: null,
    requestParams: null, responseBody: null, requestBody: { messages },
  });

  it("history mentions no longer snowball into later turns", () => {
    // 3 個 body 共用同一段含 "refactor" 的歷史，但只有第 1 個的「最新 user turn」提到 refactor
    const history = [
      { role: "user", content: [{ type: "text", text: "refactor this" }] },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
    ];
    const bodies = [
      bodyWith("r1", [{ role: "user", content: [{ type: "text", text: "refactor this" }] }]),
      bodyWith("r2", [...history, { role: "user", content: [{ type: "text", text: "add tests" }] }]),
      bodyWith("r3", [...history, { role: "user", content: [{ type: "text", text: "ship it" }] }]),
    ];
    const report = scoreWithRules({ rubric: kwRubric, usageRows: [], bodyRows: bodies });
    // 1/3 < 0.5 → 不 hit → section 停在 standard
    expect(report.sectionScores[0]!.signals[0]!.hit).toBe(false);
  });

  it("pure tool_result turns are excluded from the minRatio denominator", () => {
    const bodies = [
      bodyWith("r1", [{ role: "user", content: [{ type: "text", text: "please refactor" }] }]),
      bodyWith("r2", [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "refactor refactor" }] }]),
    ];
    const report = scoreWithRules({ rubric: kwRubric, usageRows: [], bodyRows: bodies });
    // 分母 1（r2 無真人文字）→ 1/1 >= 0.5 → hit
    expect(report.sectionScores[0]!.signals[0]!.hit).toBe(true);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `pnpm --filter @caliber/evaluator exec vitest run tests/signals/humanText.test.ts tests/engine/ruleEngine.test.ts`
Expected: FAIL（module 不存在；keyword 仍掃整包 body → snowball 測試 hit=true）

- [ ] **Step 3: 實作**

`signals/humanText.ts`（新檔，完整內容）：

```ts
/**
 * v2 keyword hygiene (docs/RUBRIC_V2_DESIGN.md §6).
 *
 * Extracts the text of the LATEST genuine human turn from a stored request
 * body, so keyword scans measure what the member actually typed this turn —
 * not the accumulated history, system prompt, or tool output.
 */

interface MessageLike {
  role?: unknown;
  content?: unknown;
}

function textBlocks(content: unknown): string[] {
  if (typeof content === "string") return content.length > 0 ? [content] : [];
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b["type"] === "text" && typeof b["text"] === "string") {
      out.push(b["text"]);
    }
  }
  return out;
}

export function extractLatestHumanText(
  requestBody: unknown,
  noiseFilters: string[],
): string | null {
  if (requestBody === null || typeof requestBody !== "object") return null;
  const messages = (requestBody as Record<string, unknown>)["messages"];
  if (!Array.isArray(messages)) return null;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as MessageLike;
    if (msg === null || typeof msg !== "object" || msg.role !== "user") continue;

    const blocks = textBlocks(msg.content);
    if (blocks.length === 0) return null; // 最後一則 user 是純 tool_result / 空 → 無真人文字

    const lowered = noiseFilters.map((f) => f.toLowerCase());
    const clean = blocks.filter(
      (t) => !lowered.some((f) => t.toLowerCase().includes(f)),
    );
    const joined = clean.join("\n").trim();
    return joined.length > 0 ? joined : null;
  }
  return null;
}
```

`signals/index.ts` re-export。`ruleEngine.ts` keyword case 改為：

```ts
    case "keyword": {
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

      const hit =
        signal.minRatio !== undefined
          ? scanTexts.length > 0 && bodiesWithHit / scanTexts.length >= signal.minRatio
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
```

**破壞性語意變更備忘**：v1 platform rubric 的 keyword hit 率會下降（這是目的）。既有 `ruleEngine.test.ts` 內 keyword 測試若 fixture 是「整包含 system prompt 的 body」，需把測試 fixture 的關鍵詞移進最後一則 user text block——修 fixture，不是修語意。

- [ ] **Step 4: 跑測試確認通過**

Run: `pnpm --filter @caliber/evaluator test && pnpm --filter @caliber/evaluator build`
Expected: 全 PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/evaluator/src/signals/ packages/evaluator/src/engine/ruleEngine.ts packages/evaluator/tests/
git commit -m "fix(evaluator): keyword signals scan only the latest human turn and honor noiseFilters"
```

---

### Task 6: facet 抽取管線 — userSatisfaction 第 7 欄位（prompt version 2）

**Files:**
- Modify: `packages/evaluator/src/facet/parser.ts`、`promptBuilder.ts`、`extractor.ts`
- Test: `packages/evaluator/tests/facet/parser.test.ts`、`promptBuilder.test.ts`、`extractor.test.ts`（各追加）

**Interfaces:**
- Consumes: 現有 `FacetSchema` / `ALLOWED_KEYS` / `CURRENT_PROMPT_VERSION` / `FacetRow` / `emptyFacetRow`。
- Produces:
  - `FacetFields` 增 `userSatisfaction: number`（1–5，**required**——version 2 prompt 強制輸出）
  - `CURRENT_PROMPT_VERSION = 2`（→ `ensureFacets` 的 cache 過濾 `promptVersion === CURRENT` 自動重抽舊列，無需手動失效）
  - `FacetRow` 增 `userSatisfaction: number | null`；`emptyFacetRow` 該欄 null

- [ ] **Step 1: 寫失敗測試**

`tests/facet/parser.test.ts` 追加：

```ts
it("parses userSatisfaction and rejects out-of-range values (v2)", () => {
  const ok = parseFacet(JSON.stringify({
    sessionType: "bug_fix", outcome: "success", claudeHelpfulness: 4,
    frictionCount: 0, bugsCaughtCount: 1, codexErrorsCount: 0,
    userSatisfaction: 5,
  }));
  expect(ok.userSatisfaction).toBe(5);

  expect(() => parseFacet(JSON.stringify({
    sessionType: "bug_fix", outcome: "success", claudeHelpfulness: 4,
    frictionCount: 0, bugsCaughtCount: 1, codexErrorsCount: 0,
    userSatisfaction: 0,
  }))).toThrow();

  // 缺 userSatisfaction → validation error（version 2 起為必填）
  expect(() => parseFacet(JSON.stringify({
    sessionType: "bug_fix", outcome: "success", claudeHelpfulness: 4,
    frictionCount: 0, bugsCaughtCount: 1, codexErrorsCount: 0,
  }))).toThrow();
});
```

`tests/facet/promptBuilder.test.ts` 追加：

```ts
it("v2 prompt declares userSatisfaction in the schema and bumps the version", () => {
  expect(CURRENT_PROMPT_VERSION).toBe(2);
  const { system } = buildFacetPrompt([{ role: "user", content: "hi" }]);
  expect(system).toContain('"userSatisfaction"');
});
```

`tests/facet/extractor.test.ts` 追加：斷言成功路徑 `insertFacet` 收到的 row 帶 `userSatisfaction`、deterministic-failure 路徑的 empty row 該欄為 `null`（比照該檔既有測試的 deps mock 寫法）。

- [ ] **Step 2: 跑測試確認失敗**

Run: `pnpm --filter @caliber/evaluator exec vitest run tests/facet/`
Expected: FAIL（schema 無此欄、version 仍為 1）

- [ ] **Step 3: 實作**

1. `parser.ts`：`FacetSchema` 加 `userSatisfaction: z.number().int().min(1).max(5),`；`ALLOWED_KEYS` 加 `"userSatisfaction"`。
2. `promptBuilder.ts`：`CURRENT_PROMPT_VERSION = 2`；system prompt 的 Schema 區塊加一行 `"userSatisfaction": 1 | 2 | 3 | 4 | 5`，定義區加：

```
userSatisfaction: how satisfied the user appears with the final outcome,
judged from closing tone and whether they accepted/used the result
(5 = explicit satisfaction or silent acceptance and moving on;
 1 = explicit frustration or abandoning the approach).
```

   三個 few-shot 範例輸出各補一個合理的 `userSatisfaction` 值（成功案例 4–5、部分成功 3、失敗 2）。
3. `extractor.ts`：`FacetRow` 加 `userSatisfaction: number | null;`；成功映射處把 `fields.userSatisfaction` 寫入；`emptyFacetRow` 加 `userSatisfaction: null`。

- [ ] **Step 4: 跑測試確認通過**

Run: `pnpm --filter @caliber/evaluator test && pnpm --filter @caliber/evaluator build`
Expected: 全 PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/evaluator/src/facet/ packages/evaluator/tests/facet/
git commit -m "feat(evaluator): facet prompt v2 adds userSatisfaction field"
```

---

### Task 7: DB schema + migrations 0029 / 0030（facet 欄位、reports 欄位）

**Files:**
- Modify: `packages/db/src/schema/requestBodyFacets.ts`、`evaluationReports.ts`、`evaluationReportsByKey.ts`
- Create: `packages/db/drizzle/0029_facet_user_satisfaction.sql` + `0029_down.sql`、`packages/db/drizzle/0030_reports_insufficient_data.sql` + `0030_down.sql`

**Interfaces:**
- Produces:
  - `requestBodyFacets.userSatisfaction`（`smallint("user_satisfaction")`，nullable）
  - `evaluationReports.totalScore` / `evaluationReportsByKey.totalScore` → **nullable**（拿掉 `.notNull()`）
  - 兩表各加 `insufficientData: boolean("insufficient_data").notNull().default(false)`

- [ ] **Step 1: 改 drizzle schema**

`requestBodyFacets.ts` 在 `codexErrorsCount` 之後加：

```ts
  /** v2 (0029): LLM-judged user satisfaction 1..5; NULL on prompt-v1 rows. */
  userSatisfaction: smallint("user_satisfaction"),
```

`evaluationReports.ts` 與 `evaluationReportsByKey.ts`：

```ts
  totalScore: decimal('total_score', { precision: 10, scale: 4 }),   // 0030: NOT NULL 移除
  /** v2 (0030): true when the rubric couldn't score for lack of samples. */
  insufficientData: boolean('insufficient_data').notNull().default(false),
```

（`boolean` 從 `drizzle-orm/pg-core` import，兩檔比照既有 import 列補上。）

- [ ] **Step 2: 手寫 migrations**

`0029_facet_user_satisfaction.sql`：

```sql
-- 0029: rubric v2 — LLM-judged user satisfaction facet (docs/RUBRIC_V2_DESIGN.md §5)
--> statement-breakpoint
ALTER TABLE "request_body_facets" ADD COLUMN "user_satisfaction" smallint;
```

`0029_down.sql`：

```sql
ALTER TABLE "request_body_facets" DROP COLUMN IF EXISTS "user_satisfaction";
```

`0030_reports_insufficient_data.sql`：

```sql
-- 0030: rubric v2 — nullable total_score + insufficient_data flag on both report tables
--> statement-breakpoint
ALTER TABLE "evaluation_reports" ALTER COLUMN "total_score" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "evaluation_reports" ADD COLUMN "insufficient_data" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "evaluation_reports_by_key" ALTER COLUMN "total_score" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "evaluation_reports_by_key" ADD COLUMN "insufficient_data" boolean NOT NULL DEFAULT false;
```

`0030_down.sql`：

```sql
UPDATE "evaluation_reports" SET "total_score" = 0 WHERE "total_score" IS NULL;
ALTER TABLE "evaluation_reports" ALTER COLUMN "total_score" SET NOT NULL;
ALTER TABLE "evaluation_reports" DROP COLUMN IF EXISTS "insufficient_data";
UPDATE "evaluation_reports_by_key" SET "total_score" = 0 WHERE "total_score" IS NULL;
ALTER TABLE "evaluation_reports_by_key" ALTER COLUMN "total_score" SET NOT NULL;
ALTER TABLE "evaluation_reports_by_key" DROP COLUMN IF EXISTS "insufficient_data";
```

**注意**：比照 0025–0027 的作法確認 `packages/db/drizzle/meta/_journal.json` 是否需要登錄新 entry（看 0027 當時的 diff：`git show 0027 相關 commit -- packages/db/drizzle/meta/`）；若 repo 慣例是手寫 SQL + journal entry，兩支都要登錄，否則 migrator 不會執行。

- [ ] **Step 3: 驗證 migration 可跑**

Run: `pnpm --filter @caliber/api exec vitest run tests/integration/migrations` （testcontainers 起 Postgres 跑全套 migration；需 Docker）
Expected: PASS（既有 0007 測試同時驗證 platform rubric 仍可 parse）。

- [ ] **Step 4: Commit**

```bash
git add packages/db/
git commit -m "feat(db): user_satisfaction facet column + nullable total_score with insufficient_data flag (0029, 0030)"
```

---

### Task 8: gateway worker — facetWriter / runRuleBased / 兩個 upsert / runEvaluation 的 null-safe 寫入

**Files:**
- Modify: `apps/gateway/src/workers/evaluator/facetWriter.ts`、`runRuleBased.ts`、`upsertEvaluationReportByKey.ts`、`runEvaluation.ts`
- Test: `apps/gateway/tests/workers/evaluator/facetWriterAndCache.integration.test.ts`、`runRuleBased.integration.test.ts`（各追加；integration 測試需 Docker/testcontainers）

**Interfaces:**
- Consumes: Task 2/4 的 `Report { totalScore: number | null; insufficientData }`、Task 6 的 `FacetRow.userSatisfaction`、Task 7 的欄位。
- Produces: 寫入層完整支援 null 分數 —— 後續 API/web 讀到的 row 形狀：`totalScore: string | null`、`insufficientData: boolean`。

- [ ] **Step 1: 寫失敗測試（integration，追加）**

`facetWriterAndCache.integration.test.ts`：寫入一列含 `userSatisfaction: 4` 的 FacetRow，讀回斷言欄位存在（比照該檔既有 insert→select 測試寫法）。

`runRuleBased.integration.test.ts`：seed `request_body_facets` 列含 `user_satisfaction`，用 continuous rubric（Task 4 測試的 `contRubric` 形狀）跑，斷言 `report.totalScore` 為數值；再跑樣本不足案例斷言 `insufficientData === true`。

- [ ] **Step 2: 實作**

1. `facetWriter.ts` insert values 與 `onConflictDoUpdate` set 各加 `userSatisfaction: row.userSatisfaction,`。
2. `runRuleBased.ts` 的 facet select（L242-255）加 `userSatisfaction: requestBodyFacets.userSatisfaction,`。
3. `runRuleBased.ts` 的 `upsertEvaluationReport` base 改：

```ts
    totalScore:
      input.report.totalScore === null ? null : String(input.report.totalScore),
    insufficientData: input.report.insufficientData,
```

4. `upsertEvaluationReportByKey.ts` 同樣兩行修改。
5. `runEvaluation.ts`：回傳型別 `totalScore: number | null`（interface 同步）；`skipped` 早退分支的 `totalScore: 0` 保持不變。
6. `runLlm.ts` / worker 記錄若有 `totalScore.toFixed(...)` 之類使用，改 null-safe（grep `totalScore` 全 gateway 確認）。

- [ ] **Step 3: 跑 gateway 測試**

Run: `pnpm --filter @caliber/evaluator build && pnpm --filter @caliber/gateway test`
Expected: 全 PASS（testcontainers 需 Docker daemon）。

- [ ] **Step 4: Commit**

```bash
git add apps/gateway/
git commit -m "feat(gateway): persist user_satisfaction facet and null-safe insufficient-data reports"
```

---

### Task 9: platform rubric v2.0.0 定義（三語）+ 分布性質測試

**Files:**
- Create: `packages/evaluator/src/rubrics/platformV2.ts`
- Modify: `packages/evaluator/src/index.ts`（re-export）
- Test: `packages/evaluator/tests/rubrics/platform-v2.test.ts`（新檔）

**Interfaces:**
- Produces: `export const platformRubricV2En: Rubric`、`platformRubricV2ZhHant`、`platformRubricV2Ja`——canonical 定義，Task 10 的 seed SQL 與測試都以此為準（single source of truth：SQL 內嵌 JSON 必須與這裡逐字一致）。

- [ ] **Step 1: 寫定義**

`packages/evaluator/src/rubrics/platformV2.ts`（en 完整內容；zh-Hant / ja 同結構，只翻譯 `name`/`description`/section `name`，數值完全相同）：

```ts
import type { Rubric } from "../rubric/schema.js";

/**
 * Platform-default rubric v2.0.0 (docs/RUBRIC_V2_DESIGN.md §5).
 * Continuous facet-based scoring mirroring the ITO quarterly KPI sub-items.
 * Curve params are INITIAL values — recalibrate via dry-run before flipping
 * is_default (see design §8 step 4).
 */
export const platformRubricV2En: Rubric = {
  name: "Platform Default v2 — Continuous Facet Scoring",
  description:
    "Continuous scoring from LLM-judged session facets; mirrors quarterly KPI sub-items (efficiency / risk control / requester satisfaction)",
  version: "2.0.0",
  locale: "en",
  scale: { max: 120, pass: 108 },
  sections: [
    {
      id: "efficiency",
      name: "Efficiency · AI Interaction / 效率·AI交互",
      weight: "25%",
      scoring: { mode: "continuous" },
      minSamples: 5,
      signals: [
        {
          type: "facet_claude_helpfulness",
          id: "helpfulness",
          gte: 3.5,
          points: 50,
          curve: { zeroAt: 2.5, fullAt: 4.5 },
        },
        {
          type: "facet_friction_per_session",
          id: "friction",
          lte: 1.0,
          points: 30,
          curve: { zeroAt: 3.0, fullAt: 0.5 },
        },
        {
          type: "cache_read_ratio",
          id: "cache_reuse",
          gte: 0.2,
          points: 20,
          curve: { zeroAt: 0.1, fullAt: 0.6 },
        },
      ],
    },
    {
      id: "riskControl",
      name: "Quality · AI Risk Control / 品質·AI風控",
      weight: "50%",
      scoring: { mode: "continuous" },
      minSamples: 5,
      signals: [
        {
          type: "facet_bugs_caught",
          id: "bugs_caught_rate",
          gte: 0.2,
          normalize: "per_session",
          points: 45,
          curve: { zeroAt: 0, fullAt: 0.5 },
        },
        {
          type: "facet_codex_errors",
          id: "codex_error_rate",
          lte: 0.5,
          normalize: "per_session",
          points: 30,
          curve: { zeroAt: 1.0, fullAt: 0.1 },
        },
        {
          type: "refusal_rate",
          id: "low_refusal_rate",
          lte: 0.2,
          points: 25,
          curve: { zeroAt: 0.3, fullAt: 0.05 },
        },
      ],
    },
    {
      id: "satisfaction",
      name: "Requester Satisfaction / 需求方滿意",
      weight: "25%",
      scoring: { mode: "continuous" },
      minSamples: 5,
      signals: [
        {
          type: "facet_outcome_success_rate",
          id: "outcome_success",
          gte: 0.6,
          points: 70,
          curve: { zeroAt: 0.4, fullAt: 0.85 },
        },
        {
          type: "facet_user_satisfaction",
          id: "user_satisfaction",
          gte: 3.5,
          points: 30,
          curve: { zeroAt: 2.5, fullAt: 4.5 },
        },
      ],
    },
  ],
  noiseFilters: [
    "<task-notification>",
    "<command-name>",
    "<local-command-caveat>",
    "<system-reminder>",
    "you are a senior code reviewer",
    "you are a code reviewer",
    "perform a deep, multi-dimensional analysis",
    "review the provided pull request",
  ],
};

export const platformRubricV2ZhHant: Rubric = {
  ...platformRubricV2En,
  name: "平台預設 v2 — 連續 facet 計分",
  description:
    "以 LLM 逐 session 判讀的 facets 連續計分；鏡射季評分 KPI 子項（效率／風控／需求方滿意）",
  locale: "zh-Hant",
  sections: platformRubricV2En.sections.map((s) => ({
    ...s,
    name:
      s.id === "efficiency"
        ? "效率·AI交互"
        : s.id === "riskControl"
          ? "品質·AI風控"
          : "需求方滿意",
  })),
};

export const platformRubricV2Ja: Rubric = {
  ...platformRubricV2En,
  name: "プラットフォームデフォルト v2 — 連続ファセットスコアリング",
  description:
    "LLMがセッション毎に判定したファセットによる連続スコアリング；四半期KPIサブ項目（効率／リスク管理／依頼者満足）を反映",
  locale: "ja",
  sections: platformRubricV2En.sections.map((s) => ({
    ...s,
    name:
      s.id === "efficiency"
        ? "効率·AI対話"
        : s.id === "riskControl"
          ? "品質·AIリスク管理"
          : "依頼者満足",
  })),
};
```

`packages/evaluator/src/index.ts` 加 `export { platformRubricV2En, platformRubricV2ZhHant, platformRubricV2Ja } from "./rubrics/platformV2.js";`（比照既有 export 風格）。

- [ ] **Step 2: 寫分布性質測試（先跑先失敗，因定義檔尚未 export 時順序對調亦可——TDD 上以「性質」為測試主體）**

`packages/evaluator/tests/rubrics/platform-v2.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { rubricSchema } from "../../src/rubric/schema.js";
import { scoreWithRules } from "../../src/engine/ruleEngine.js";
import {
  platformRubricV2En,
  platformRubricV2ZhHant,
  platformRubricV2Ja,
} from "../../src/rubrics/platformV2.js";
import type { FacetRowInput } from "../../src/signals/facet.js";

const mk = (over: Partial<FacetRowInput>): FacetRowInput => ({
  sessionType: "feature_dev",
  outcome: "success",
  claudeHelpfulness: 4,
  frictionCount: 1,
  bugsCaughtCount: 0,
  codexErrorsCount: 0,
  userSatisfaction: 4,
  ...over,
});

const strongMember = Array.from({ length: 20 }, () =>
  mk({ claudeHelpfulness: 5, frictionCount: 0, bugsCaughtCount: 1, userSatisfaction: 5 }),
);
const averageMember = Array.from({ length: 20 }, (_, i) =>
  mk({
    claudeHelpfulness: 3,
    frictionCount: 2,
    bugsCaughtCount: i % 5 === 0 ? 1 : 0,
    outcome: i % 3 === 0 ? "partial" : i % 3 === 1 ? "success" : "failure",
    userSatisfaction: 3,
  }),
);
const weakMember = Array.from({ length: 20 }, () =>
  mk({
    claudeHelpfulness: 2,
    frictionCount: 3,
    codexErrorsCount: 2,
    outcome: "abandoned",
    userSatisfaction: 2,
  }),
);

const score = (facetRows: FacetRowInput[]) =>
  scoreWithRules({ rubric: platformRubricV2En, usageRows: [], bodyRows: [], facetRows })
    .totalScore;

describe("platform rubric v2", () => {
  it("all three locales pass schema validation", () => {
    for (const r of [platformRubricV2En, platformRubricV2ZhHant, platformRubricV2Ja]) {
      expect(rubricSchema.safeParse(r).success).toBe(true);
    }
  });

  it("weights sum to 100% and every continuous section's points sum to 100", () => {
    const weights = platformRubricV2En.sections.map((s) => Number(s.weight.replace("%", "")));
    expect(weights.reduce((a, b) => a + b, 0)).toBe(100);
    for (const s of platformRubricV2En.sections) {
      const pts = s.signals.reduce((a, sig) => a + (sig.points ?? 0), 0);
      expect(pts).toBe(100);
    }
  });

  it("DISCRIMINATES: strong > average > weak, none saturated at 120", () => {
    const strong = score(strongMember)!;
    const avg = score(averageMember)!;
    const weak = score(weakMember)!;
    expect(strong).toBeGreaterThan(avg);
    expect(avg).toBeGreaterThan(weak);
    expect(strong - weak).toBeGreaterThan(20); // 至少拉出 20 分級距
    expect(avg).toBeLessThan(110);
    expect(weak).toBeLessThan(80);
  });

  it("returns insufficient data below minSamples instead of a fake score", () => {
    const r = scoreWithRules({
      rubric: platformRubricV2En,
      usageRows: [],
      bodyRows: [],
      facetRows: strongMember.slice(0, 3), // < 5
    });
    expect(r.totalScore).toBeNull();
    expect(r.insufficientData).toBe(true);
  });
});
```

- [ ] **Step 3: 跑測試（含全套）**

Run: `pnpm --filter @caliber/evaluator test`
Expected: 全 PASS。若 DISCRIMINATES 測試的具體數字不符，調整**測試的預期帶**而非亂調曲線——曲線初值以設計文件為準，正式校準在 dry-run 階段。

- [ ] **Step 4: Commit**

```bash
git add packages/evaluator/src/rubrics/ packages/evaluator/src/index.ts packages/evaluator/tests/rubrics/platform-v2.test.ts
git commit -m "feat(evaluator): platform rubric v2.0.0 definitions (en/zh-Hant/ja) with distribution property tests"
```

---

### Task 10: seed migration 0031 — v2 rubrics（is_default=false）

**Files:**
- Create: `packages/db/drizzle/0031_seed_platform_rubric_v2.sql` + `0031_down.sql`
- Test: `apps/api/tests/integration/migrations/0031.test.ts`（新檔，比照 `0007.test.ts`）

**Interfaces:**
- Produces: DB 裡三列新 rubric（`org_id IS NULL`、**`is_default = false`**、`version = '2.0.0'`、name 含 "v2"）。v1 三列不動、仍是 default。翻轉 default 是校準後的獨立 migration（**不在本計畫範圍**）。

- [ ] **Step 1: 寫 migration**

`0031_seed_platform_rubric_v2.sql` 結構比照 `0003_seed_platform_rubrics.sql`（三個 INSERT、`$json$...$json$::jsonb`），JSON 內容 = Task 9 三個 TS 物件的 JSON 序列化（**逐字一致**，含 `scale`、`scoring`、`points`、`curve`、`normalize`、`minSamples`）。欄位：`is_default` 填 **false**、`version` `'2.0.0'`、`created_by` NULL。

產生 JSON 的輔助（先 `pnpm --filter @caliber/evaluator build`，再執行一次、把三段輸出貼進 SQL 的 `$json$...$json$` 區塊）：

```bash
node --input-type=module -e "
import * as m from './packages/evaluator/dist/rubrics/platformV2.js';
for (const k of ['platformRubricV2En','platformRubricV2ZhHant','platformRubricV2Ja']) {
  console.log('--- ' + k + ' ---');
  console.log(JSON.stringify(m[k], null, 2));
}"
```

`0031_down.sql`：

```sql
DELETE FROM rubrics WHERE org_id IS NULL AND version = '2.0.0' AND is_default = false;
```

比照 Task 7 的備忘處理 `meta/_journal.json`。

- [ ] **Step 2: 寫 integration 測試**

`apps/api/tests/integration/migrations/0031.test.ts`（結構抄 `0007.test.ts`）：跑完 migrations 後 select `org_id IS NULL AND version='2.0.0'` 三列，斷言 (a) 三個 locale 各一列、(b) 每列 `rubricSchema.safeParse(definition).success === true`、(c) `is_default === false`、(d) v1 default 三列仍 `is_default = true`。

- [ ] **Step 3: 跑測試**

Run: `pnpm --filter @caliber/api exec vitest run tests/integration/migrations`
Expected: PASS。

- [ ] **Step 4: Commit**

```bash
git add packages/db/drizzle/ apps/api/tests/integration/migrations/0031.test.ts
git commit -m "feat(db): seed platform rubric v2.0.0 (en/zh-Hant/ja, is_default=false pending calibration)"
```

---

### Task 11: API — `rubrics.dryRun` 載入 facetRows（v2 校準的前提）

**Files:**
- Modify: `apps/api/src/trpc/routers/rubrics.ts`（dryRun，L431-514）
- Test: `apps/api/tests/integration/trpc/rubrics.test.ts`（追加）

**Interfaces:**
- Consumes: dryRun 既有 input `{ orgId, rubricId, userId, days }`；`request_body_facets` 是明文欄位（**不需要** CREDENTIAL_ENCRYPTION_KEY——這是 dry-run 能做 facet 計分的關鍵）。
- Produces: dryRun 回傳的 `preview: Report` 現在含 facet-signal 分數與 `insufficientData`。`usageOnly` 欄位改名語意 → 保留欄位但值改為 `bodyRows.length === 0`（向後相容，仍為 true）。

- [ ] **Step 1: 寫失敗測試**（追加到 `rubrics.test.ts`，比照該檔既有 dryRun 測試的 seed/caller 寫法）

seed：usage_logs N 列（requestId 已知）+ `request_body_facets` 對應列（`user_satisfaction`、`claude_helpfulness` 等有值）。用 Task 9 的 v2 rubric 建一列 org rubric，呼叫 `rubrics.dryRun`。斷言 `preview.totalScore` 非 null 且非 0/120 的極值、`preview.sectionScores.every(s => s.mode === "continuous")`。

- [ ] **Step 2: 實作**

在 usageLogs select 之後（既有 L469-487）加 facet 載入（形狀抄 `runRuleBased.ts` L242-255，多一欄 userSatisfaction）：

```ts
      const requestIds = usageRows.map((u) => u.requestId);
      const facetRows =
        requestIds.length === 0
          ? []
          : await ctx.db
              .select({
                sessionType: requestBodyFacets.sessionType,
                outcome: requestBodyFacets.outcome,
                claudeHelpfulness: requestBodyFacets.claudeHelpfulness,
                frictionCount: requestBodyFacets.frictionCount,
                bugsCaughtCount: requestBodyFacets.bugsCaughtCount,
                codexErrorsCount: requestBodyFacets.codexErrorsCount,
                userSatisfaction: requestBodyFacets.userSatisfaction,
              })
              .from(requestBodyFacets)
              .where(inArray(requestBodyFacets.requestId, requestIds));
```

`scoreWithRules({ rubric, usageRows, bodyRows: [], facetRows })`。import `requestBodyFacets`、`inArray` 比照檔內既有 import。JSDoc（L416-429）補一句：facet signals 自 v2 起在 dry-run 生效；keyword/refusal 類仍因無 body 而 0 hit。

- [ ] **Step 3: 跑測試**

Run: `pnpm --filter @caliber/evaluator build && pnpm --filter @caliber/api test`
Expected: PASS。

- [ ] **Step 4: Commit**

```bash
git add apps/api/
git commit -m "feat(api): rubrics.dryRun loads facet rows so v2 continuous rubrics preview real scores"
```

---

### Task 12: web — 鏡像型別同步、continuous 渲染、資料不足狀態、及格線

**Files:**
- Modify: `apps/web/src/components/evaluator/reportDetailShared.tsx`、`rubricThreshold.ts`、`SignalBreakdown.tsx`、`ReportDetail.tsx`、`ProfileEvaluation.tsx`、`MemberScoreCell.tsx`、`TeamLeaderboard.tsx`、`TrendChart.tsx`、`DryRunPreview.tsx`、`RubricEditor.tsx`
- Modify: web i18n 訊息檔（以 `grep -r '"superior"' apps/web/src --include='*.json'` 定位；en/zh-Hant/ja 各加 `insufficientData`、`passLine` 兩個 key）
- Test: `apps/web/tests/components/evaluator/reportDetailShared.test.tsx`、`SignalBreakdown.test.tsx`、`rubricThreshold.test.ts`（各追加）

**Interfaces:**
- Consumes: row 形狀 `totalScore: string | null` + `insufficientData: boolean`（tRPC 自動反映 Task 7 的 drizzle 變更）；sectionScores jsonb 內的新欄位 `mode` / `maxScore` / `earnedPoints` / `maxPoints` / `sampleCount`、`score: number | null`。
- Produces: 使用者可見行為 —
  1. 分數為 null 或 `insufficientData` 的報告在所有入口顯示「資料不足」badge（灰色），不顯示數字。
  2. continuous section 列顯示 `score / maxScore`（一位小數），展開後每個 signal 顯示 `earnedPoints / maxPoints`＋量測值；不再顯示 superior pill。
  3. TrendChart 畫 108 及格虛線。

- [ ] **Step 1: 寫失敗測試**（追加；渲染斷言比照各檔既有測試風格）

`reportDetailShared.test.tsx`：
- continuous section fixture（`mode:"continuous", score: 96.4, maxScore: 120, signals:[{id:"helpfulness", value:4.2, earnedPoints:42.5, maxPoints:50, sampleCount:18, hit:true, type:"facet_claude_helpfulness"}]`）→ 渲染出 `96.4`、不出現 superior pill。
- `score: null` section → 渲染「資料不足」badge 文案 key。

`rubricThreshold.test.ts`：`formatThreshold({ type: "facet_user_satisfaction", id: "x", gte: 3.5 })` 回傳含 `≥ 3.5` 的字串；帶 `curve` 的 signal 回傳 `curve 2.5→4.5` 樣式字串。

- [ ] **Step 2: 實作（每檔的具體變更）**

1. `reportDetailShared.tsx`：
   - `SectionResult` mirror 加 `mode?: "tiered" | "continuous"; maxScore?: number;`，`score: number | null;`；`SignalHit` mirror 加 `sampleCount?: number; earnedPoints?: number; maxPoints?: number;`。
   - `SectionRow`：`section.score === null` → 分數格渲染 `<span className="...zinc badge">{t("insufficientData")}</span>`；`section.mode === "continuous"` → 分數顯示 `${score.toFixed(1)} / ${maxScore}`，且 `isSuperior` 判斷改為 `section.mode !== "continuous" && score === superiorScore && superiorScore > standardScore`。
   - `scoreColorClass` / `scoreBadgeClass` 簽名改收 `number | null`，null → zinc 灰。
2. `SignalBreakdown.tsx`：`BreakdownSignal` 加同三欄位；有 `earnedPoints` 時在該列尾端渲染 `{earnedPoints.toFixed(1)} / {maxPoints} pts`；`sampleCount !== undefined` 時附 `n={sampleCount}`。
3. `rubricThreshold.ts`：`RubricSignal` union 加 `facet_user_satisfaction` variant 與共用 optional `points`/`curve`/`normalize` 欄位；`formatThreshold` 加 case（文案：`滿意度均值 ≥ {gte}` 級別由既有檔案語言慣例決定——該檔是英文就用 `mean satisfaction ≥ {gte}`）；curve 存在時 append `· curve {zeroAt}→{fullAt}`。
4. `ReportDetail.tsx` / `ProfileEvaluation.tsx`：`latestScore` 計算改 `latest.totalScore === null ? null : parseFloat(latest.totalScore)`；null 或 `latest.insufficientData` → header badge 顯示「資料不足」，trend series 略過該點。
5. `MemberScoreCell.tsx` / `TeamLeaderboard.tsx`：同樣 null-safe；leaderboard 排序時 null 沉底。
6. `TrendChart.tsx`：加 `const PASS_SCORE = 108;`，在 `Y_TICKS` 迴圈外多畫一條 `stroke-amber-400 stroke-dasharray="6 3"` 的水平線於 `toY(PASS_SCORE)`，並在右端標 `108`。`Y_TICKS` 改 `[0, 40, 80, 108, 120]`。
7. `DryRunPreview.tsx`：`preview.totalScore === null` → PreviewCard 大字位置渲染「資料不足」badge + 顯示 `preview.dataQuality`；section 列 `sec.score === null` 同樣處理；`<ScoreBar>` 只在數值存在時渲染，continuous section 的 max 用 `sec.maxScore ?? sec.superiorScore`。
8. `RubricEditor.tsx` L369-461 的 signal-type `<details>` 說明：加 `facet_user_satisfaction` 條目與 continuous 欄位（`scoring.mode` / `points` / `curve` / `minSamples` / `normalize` / `scale`）的簡述與一段範例 JSON（可直接貼 Task 9 的 satisfaction section）。
9. i18n 訊息檔三語各加：`insufficientData`（en: `Insufficient data`、zh-Hant: `資料不足`、ja: `データ不足`）、`passLine`（en: `pass 108`、zh-Hant: `及格 108`、ja: `合格 108`）。

- [ ] **Step 3: 跑 web 測試 + typecheck**

Run: `pnpm --filter @caliber/web test && pnpm --filter @caliber/web exec tsc --noEmit`
Expected: 全 PASS（`totalScore: string | null` 的型別變更會讓漏改的 `parseFloat` 呼叫點在 tsc 現形——逐一修完）。

- [ ] **Step 4: Commit**

```bash
git add apps/web/
git commit -m "feat(web): continuous-section rendering, insufficient-data states, 108 pass line"
```

---

### Task 13: 全量驗證 + 文件

**Files:**
- Modify: `docs/EVALUATOR.md`（rubric 章節補 v2 說明與 §5 分數表）、`docs/RUBRIC_V2_DESIGN.md`（Status 補 implementation PR 連結）

- [ ] **Step 1: 全 repo 驗證**

```bash
pnpm build && pnpm test
```
Expected: 全 workspace build + test PASS（gateway/api integration 需 Docker）。

- [ ] **Step 2: 手動 smoke（本機 docker compose，非 prod）**

比照 `docs/LOCAL_DEPLOY.md` 起本機 stack，用 admin UI：RubricList 應列出 v2 rubric（非 default）；對自己跑 DryRunPreview 選 v2 → 應顯示連續分數或「資料不足」。**這一步的產出貼進 PR description 當校準基線。**

- [ ] **Step 3: 文件 + PR**

`docs/EVALUATOR.md` 補：continuous 計分模式說明、v2 rubric 分數表（引 design doc）、「v2 目前 is_default=false，校準後翻轉」注意事項。開 PR（base main，title `feat: rubric v2 continuous scoring`），body 含設計文件連結、smoke 結果、「翻轉 default 需另一支 migration + 校準報告」的 checklist。

```bash
git add docs/
git commit -m "docs: evaluator rubric v2 continuous scoring"
```

---

## 範圍外（明確不在本計畫）

- **is_default 翻轉 migration**：待 11 位成員 dry-run 校準通過後另出（設計 §8 step 4）。
- **prod 部署與 facet 重抽**：prompt version 2 會讓下次評分自動重抽 facets（LLM 成本一次性上升）——部署時機由 operator 決定。
- LLM 直接調分、跨成員 percentile 計分（設計 §2 非目標）。



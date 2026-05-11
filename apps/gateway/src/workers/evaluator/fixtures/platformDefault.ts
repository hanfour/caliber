/**
 * Platform-default rubric stub (Plan 4B Part 4, Task 4.2).
 *
 * Minimal 2-section rubric to unblock Part 4. Real platform rubrics are seeded
 * in Part 9; the `rubricResolver` (Task 4.4) will replace this stub.
 */

import type { Rubric } from "@caliber/evaluator";

export const platformDefaultRubric: Rubric = {
  name: "Platform default (Part 4 stub)",
  version: "0.1.0-stub",
  locale: "en",
  sections: [
    {
      id: "interaction",
      name: "Interaction Quality",
      weight: "50%",
      standard: {
        score: 100,
        label: "Standard",
        criteria: ["baseline engagement"],
      },
      superior: {
        score: 120,
        label: "Superior",
        criteria: ["rich exploration"],
      },
      signals: [
        { type: "cache_read_ratio", id: "cr", gte: 0.2 },
        { type: "iteration_count", id: "ic", gte: 2 },
      ],
    },
    {
      id: "risk",
      name: "Risk Posture",
      weight: "50%",
      standard: {
        score: 100,
        label: "Standard",
        criteria: ["low refusal rate"],
      },
      superior: {
        score: 120,
        label: "Superior",
        criteria: ["very low refusal"],
      },
      signals: [{ type: "refusal_rate", id: "rr", lte: 0.05 }],
    },
  ],
};

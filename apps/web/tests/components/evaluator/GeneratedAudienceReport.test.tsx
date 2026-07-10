import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { GeneratedAudienceReport } from "@/components/evaluator/GeneratedAudienceReport";

const userReport = {
  title: "Your engineering report",
  summary: "You consistently validate changes against the rubric.",
  strengths: [
    {
      sectionId: "quality",
      title: "Strong verification",
      detail: "Your changes include focused tests.",
    },
  ],
  growthAreas: [
    {
      sectionId: "efficiency",
      title: "Reduce repeated work",
      detail: "Some workflows repeat discovery steps.",
      action: "Record the decision before implementation.",
    },
  ],
  nextSteps: [
    {
      sectionId: "efficiency",
      title: "Use a verification checklist",
      rationale: "It maps directly to the configured rubric.",
      priority: "high" as const,
    },
  ],
};

const adminReport = {
  title: "Engineering effectiveness report",
  executiveSummary: "The engineer meets the quality bar with one coaching opportunity.",
  performanceAssessment: "Quality is stable while efficiency varies by task type.",
  strengths: [
    {
      sectionId: "quality",
      title: "Strong verification",
      detail: "Focused tests are consistently present.",
    },
  ],
  concerns: [
    {
      sectionId: "efficiency",
      title: "Repeated discovery",
      detail: "Several sessions repeat the same repository search.",
      severity: "medium" as const,
      evidenceRequestIds: ["req-1", "req-2"],
    },
  ],
  coachingPlan: [
    {
      sectionId: "efficiency",
      title: "Plan before editing",
      rationale: "A short plan should reduce repeated discovery.",
      priority: "medium" as const,
      successMeasure: "Repeated searches decline in the next review window.",
    },
  ],
  calibrationNotes: ["Compare against the configured rubric only."],
  dataLimitations: ["The sample covers one 30-day window."],
};

describe("GeneratedAudienceReport", () => {
  it("renders the user report as actionable feedback", () => {
    render(
      <GeneratedAudienceReport
        audience="user"
        report={userReport}
        model="claude-test"
      />,
    );

    expect(screen.getByText("Your engineering report")).toBeInTheDocument();
    expect(screen.getByText("Strong verification")).toBeInTheDocument();
    expect(screen.getByText("Reduce repeated work")).toBeInTheDocument();
    expect(screen.getByText("Use a verification checklist")).toBeInTheDocument();
    expect(screen.queryByText("Items requiring attention")).not.toBeInTheDocument();
  });

  it("renders admin-only diagnostic and coaching sections", () => {
    render(
      <GeneratedAudienceReport
        audience="admin"
        report={adminReport}
        model="claude-test"
      />,
    );

    expect(screen.getByText("Engineering effectiveness report")).toBeInTheDocument();
    expect(screen.getByText("Repeated discovery")).toBeInTheDocument();
    expect(screen.getByText("Plan before editing")).toBeInTheDocument();
    expect(screen.getByText("The sample covers one 30-day window.")).toBeInTheDocument();
    expect(screen.getByText(/Supported by 2 evidence item/)).toBeInTheDocument();
  });

  it("renders nothing for a redacted or invalid payload", () => {
    const { container, rerender } = render(
      <GeneratedAudienceReport audience="redacted" report={adminReport} />,
    );
    expect(container).toBeEmptyDOMElement();

    rerender(<GeneratedAudienceReport audience="user" report={{ title: "invalid" }} />);
    expect(container).toBeEmptyDOMElement();
  });
});

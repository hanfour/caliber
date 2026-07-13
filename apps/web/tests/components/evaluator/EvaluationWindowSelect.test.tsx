import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  EvaluationWindowSelect,
  windowRange,
  WINDOW_PRESETS,
  DEFAULT_WINDOW_DAYS,
} from "@/components/evaluator/EvaluationWindowSelect";

describe("windowRange", () => {
  it("spans the requested number of days", () => {
    const { from, to } = windowRange(7);
    const spanMs = new Date(to).getTime() - new Date(from).getTime();
    expect(spanMs).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("defaults to 30 and offers 7/30/90 presets", () => {
    expect(DEFAULT_WINDOW_DAYS).toBe(30);
    expect(WINDOW_PRESETS).toEqual([7, 30, 90]);
  });
});

describe("EvaluationWindowSelect", () => {
  it("renders one button per preset and marks the active one", () => {
    render(<EvaluationWindowSelect value={30} onChange={() => {}} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(WINDOW_PRESETS.length);
    const active = buttons.find((b) => b.getAttribute("aria-pressed") === "true");
    expect(active?.textContent).toContain("30");
  });

  it("calls onChange with the picked window", async () => {
    const onChange = vi.fn();
    render(<EvaluationWindowSelect value={30} onChange={onChange} />);
    const seven = screen
      .getAllByRole("button")
      .find((b) => b.textContent?.includes("7"))!;
    await userEvent.click(seven);
    expect(onChange).toHaveBeenCalledWith(7);
  });
});

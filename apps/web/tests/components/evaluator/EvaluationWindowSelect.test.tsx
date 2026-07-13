import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  EvaluationWindowSelect,
  windowRange,
  selectionToRange,
  rangeDays,
  WINDOW_PRESETS,
  DEFAULT_SELECTION,
  RERUN_MAX_DAYS,
  type WindowSelection,
} from "@/components/evaluator/EvaluationWindowSelect";

const DAY = 24 * 60 * 60 * 1000;

describe("range helpers", () => {
  it("windowRange spans the requested days", () => {
    const { from, to } = windowRange(7);
    expect(new Date(to).getTime() - new Date(from).getTime()).toBe(7 * DAY);
  });

  it("selectionToRange honours a preset", () => {
    const { from, to } = selectionToRange({ mode: "preset", days: 90 });
    expect(new Date(to).getTime() - new Date(from).getTime()).toBe(90 * DAY);
  });

  it("selectionToRange honours a valid custom range (whole days, TZ-agnostic)", () => {
    // Dates are interpreted at the viewer's local midnight, so assert the span
    // (07-01 00:00 → 07-10 23:59:59.999 ≈ 10 days) rather than a fixed ISO date.
    const r = selectionToRange({
      mode: "custom",
      fromDate: "2026-07-01",
      toDate: "2026-07-10",
    });
    expect(new Date(r.to).getTime()).toBeGreaterThan(new Date(r.from).getTime());
    expect(Math.round(rangeDays(r.from, r.to))).toBe(10);
  });

  it("selectionToRange falls back to 30 days on an inverted/invalid custom range", () => {
    const r = selectionToRange({
      mode: "custom",
      fromDate: "2026-07-10",
      toDate: "2026-07-01",
    });
    expect(Math.round(rangeDays(r.from, r.to))).toBe(30);
  });

  it("defaults to the 30-day preset", () => {
    expect(DEFAULT_SELECTION).toEqual({ mode: "preset", days: 30 });
    expect(RERUN_MAX_DAYS).toBe(30);
  });
});

describe("EvaluationWindowSelect", () => {
  it("renders a button per preset plus Custom, marking the active one", () => {
    render(
      <EvaluationWindowSelect
        value={{ mode: "preset", days: 30 }}
        onChange={() => {}}
      />,
    );
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(WINDOW_PRESETS.length + 1);
    const active = buttons.find((b) => b.getAttribute("aria-pressed") === "true");
    expect(active?.textContent).toContain("30");
  });

  it("emits a preset selection when a preset is clicked", async () => {
    const onChange = vi.fn<(s: WindowSelection) => void>();
    render(
      <EvaluationWindowSelect
        value={{ mode: "preset", days: 30 }}
        onChange={onChange}
      />,
    );
    const seven = screen
      .getAllByRole("button")
      .find((b) => b.textContent?.includes("7"))!;
    await userEvent.click(seven);
    expect(onChange).toHaveBeenCalledWith({ mode: "preset", days: 7 });
  });

  it("switches to custom and shows two date inputs", async () => {
    const onChange = vi.fn<(s: WindowSelection) => void>();
    const { rerender } = render(
      <EvaluationWindowSelect
        value={{ mode: "preset", days: 30 }}
        onChange={onChange}
      />,
    );
    const custom = screen.getAllByRole("button").at(-1)!;
    await userEvent.click(custom);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "custom" }),
    );

    rerender(
      <EvaluationWindowSelect
        value={{ mode: "custom", fromDate: "2026-07-01", toDate: "2026-07-10" }}
        onChange={onChange}
      />,
    );
    const dateInputs = screen
      .getAllByDisplayValue(/2026-07/)
      .filter((el) => (el as HTMLInputElement).type === "date");
    expect(dateInputs).toHaveLength(2);
  });
});

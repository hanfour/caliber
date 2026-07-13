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
  lastCompletedQuarter,
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
  });

  it("RERUN_MAX_DAYS is one quarter (92 days)", () => {
    expect(RERUN_MAX_DAYS).toBe(92);
  });

  it("lastCompletedQuarter returns a prior, ≤92-day quarter", () => {
    const q = lastCompletedQuarter();
    expect(q.quarter).toBeGreaterThanOrEqual(1);
    expect(q.quarter).toBeLessThanOrEqual(4);
    const span = rangeDays(q.from, q.to);
    expect(span).toBeGreaterThan(89);
    expect(span).toBeLessThanOrEqual(92);
    // The quarter is fully in the past.
    expect(new Date(q.to).getTime()).toBeLessThan(Date.now());
  });

  it("selectionToRange resolves the quarter mode to the last quarter", () => {
    const q = lastCompletedQuarter();
    const r = selectionToRange({ mode: "quarter" });
    expect(r.from).toBe(q.from);
    expect(r.to).toBe(q.to);
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
    expect(buttons).toHaveLength(WINDOW_PRESETS.length + 2);
    const active = buttons.find((b) => b.getAttribute("aria-pressed") === "true");
    expect(active?.textContent).toContain("30");
  });

  it("renders a 上季 button that emits the quarter selection", async () => {
    const onChange = vi.fn<(s: WindowSelection) => void>();
    render(
      <EvaluationWindowSelect value={{ mode: "preset", days: 30 }} onChange={onChange} />,
    );
    // Presets (3) + 上季 (quarter) + 自訂 (custom) = 5 buttons.
    // Tests stub next-intl against the English catalogue (see tests/setup.ts),
    // so the button renders its English copy ("Last quarter") even though the
    // production zh-TW/zh-CN/ko/en catalogues each carry the localized label
    // (zh-TW: "上季").
    expect(screen.getAllByRole("button")).toHaveLength(5);
    const quarter = screen.getByText("Last quarter");
    await userEvent.click(quarter);
    expect(onChange).toHaveBeenCalledWith({ mode: "quarter" });
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

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ExpiryCountdown } from "@/components/status/ExpiryCountdown";

describe("ExpiryCountdown", () => {
  it("renders an em dash when expiresAt is null (no expiry)", () => {
    render(<ExpiryCountdown expiresAt={null} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("renders 'Expired' when expiresAt is in the past", () => {
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    render(<ExpiryCountdown expiresAt={past} />);
    expect(screen.getByText("Expired")).toBeInTheDocument();
  });

  it("renders a day countdown when expiresAt is in the future", () => {
    // 4.5 days out → Math.ceil(4.5) === 5 → "5d". Using a non-integer
    // multiple of a day keeps the assertion stable regardless of the small
    // elapsed time between constructing `future` and reading Date.now() in
    // the component (an exact N-day offset would flip ceil to N+1).
    const future = new Date(Date.now() + 4.5 * 24 * 60 * 60 * 1000).toISOString();
    render(<ExpiryCountdown expiresAt={future} />);
    expect(screen.getByText("5d")).toBeInTheDocument();
  });
});

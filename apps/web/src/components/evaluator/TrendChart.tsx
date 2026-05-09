"use client";

// Pure SVG trend chart — no chart library dependency.
// Mirrors the horizontal-bar approach in UsageChart: lightweight, no extra bundle cost.

import { useTranslations } from "next-intl";

const VIEWBOX_W = 600;
const VIEWBOX_H = 160;
const PAD_LEFT = 36;
const PAD_RIGHT = 12;
const PAD_TOP = 12;
const PAD_BOTTOM = 24;

const PLOT_W = VIEWBOX_W - PAD_LEFT - PAD_RIGHT;
const PLOT_H = VIEWBOX_H - PAD_TOP - PAD_BOTTOM;

const SCORE_MIN = 0;
const SCORE_MAX = 120;

export interface ScorePoint {
  date: string; // ISO or "YYYY-MM-DD"
  score: number;
}

interface Props {
  series: ScorePoint[];
  teamSeries?: ScorePoint[]; // optional second line
}

// Map a score value to a Y pixel coordinate (top-aligned SVG).
function toY(score: number): number {
  const clamped = Math.min(SCORE_MAX, Math.max(SCORE_MIN, score));
  return PAD_TOP + PLOT_H * (1 - (clamped - SCORE_MIN) / (SCORE_MAX - SCORE_MIN));
}

// Map an index position to an X pixel coordinate.
function toX(i: number, total: number): number {
  if (total <= 1) return PAD_LEFT + PLOT_W / 2;
  return PAD_LEFT + (i / (total - 1)) * PLOT_W;
}

function buildLinePath(points: ScorePoint[]): string {
  if (points.length === 0) return "";
  return points
    .map((p, i) => {
      const x = toX(i, points.length);
      const y = toY(p.score);
      return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
}

function buildAreaPath(points: ScorePoint[]): string {
  if (points.length === 0) return "";
  const line = buildLinePath(points);
  const lastX = toX(points.length - 1, points.length).toFixed(1);
  const firstX = toX(0, points.length).toFixed(1);
  const baseline = (PAD_TOP + PLOT_H).toFixed(1);
  return `${line} L ${lastX} ${baseline} L ${firstX} ${baseline} Z`;
}

// Y-axis tick values
const Y_TICKS = [0, 40, 80, 100, 120];

export function TrendChart({ series, teamSeries }: Props) {
  const t = useTranslations("evaluator.trendChart");
  const total = series.length;

  if (total === 0) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
        {t("noData")}
      </div>
    );
  }

  // Build a sparse label set: show at most ~5 evenly spaced date labels.
  const labelStep = Math.max(1, Math.floor(total / 5));
  const dateLabels: { i: number; label: string }[] = series
    .map((p, i) => ({ i, label: p.date.slice(5) })) // "MM-DD"
    .filter((_, i) => i === 0 || i === total - 1 || i % labelStep === 0);

  const linePath = buildLinePath(series);
  const areaPath = buildAreaPath(series);
  const teamLinePath = teamSeries ? buildLinePath(teamSeries) : "";

  const gradId = "trendFill";

  return (
    <svg
      viewBox={`0 0 ${VIEWBOX_W} ${VIEWBOX_H}`}
      className="w-full"
      aria-label={t("ariaLabel")}
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity="0.25" />
          <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity="0.02" />
        </linearGradient>
      </defs>

      {/* Y-axis grid lines + labels */}
      {Y_TICKS.map((tick) => {
        const y = toY(tick);
        return (
          <g key={tick}>
            <line
              x1={PAD_LEFT}
              y1={y}
              x2={PAD_LEFT + PLOT_W}
              y2={y}
              stroke="hsl(var(--border))"
              strokeWidth="1"
              strokeDasharray={tick === 0 ? "none" : "3 3"}
            />
            <text
              x={PAD_LEFT - 4}
              y={y + 4}
              textAnchor="end"
              fontSize="9"
              fill="hsl(var(--muted-foreground))"
            >
              {tick}
            </text>
          </g>
        );
      })}

      {/* Area fill under member line */}
      <path d={areaPath} fill={`url(#${gradId})`} />

      {/* Team average line (if provided) */}
      {teamLinePath && (
        <path
          d={teamLinePath}
          fill="none"
          stroke="hsl(var(--muted-foreground))"
          strokeWidth="1.5"
          strokeDasharray="4 3"
          opacity="0.7"
        />
      )}

      {/* Member score line */}
      <path
        d={linePath}
        fill="none"
        stroke="hsl(var(--primary))"
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />

      {/* Data point dots with tooltip title */}
      {series.map((p, i) => (
        <circle
          key={p.date}
          cx={toX(i, total)}
          cy={toY(p.score)}
          r="3"
          fill="hsl(var(--primary))"
          opacity="0.85"
        >
          <title>{`${p.date}: ${p.score}`}</title>
        </circle>
      ))}

      {/* X-axis date labels */}
      {dateLabels.map(({ i, label }) => (
        <text
          key={label}
          x={toX(i, total)}
          y={VIEWBOX_H - 4}
          textAnchor="middle"
          fontSize="9"
          fill="hsl(var(--muted-foreground))"
        >
          {label}
        </text>
      ))}
    </svg>
  );
}

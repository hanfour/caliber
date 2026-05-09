"use client";

import { useTranslations } from "next-intl";

interface Props {
  months: Array<{ month: string; costUsd: number }>;
}

export function HistoricalSpendChart({ months }: Props) {
  const t = useTranslations("evaluator.costs");
  if (months.length === 0) {
    return (
      <p className="text-sm text-muted-foreground italic">
        {t("noHistoricalData")}
      </p>
    );
  }

  const max = Math.max(...months.map((m) => m.costUsd), 0.01);
  const W = 600;
  const H = 200;
  const PAD_X = 20;
  const PAD_BOTTOM = 30;
  const PAD_TOP = 20;
  const barW = (W - PAD_X * 2) / months.length - 8;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full h-48"
      role="img"
      aria-label="Historical monthly LLM spend (last 6 months)"
    >
      {months.map((m, i) => {
        const cx =
          PAD_X + i * ((W - PAD_X * 2) / months.length) + barW / 2 + 4;
        const h = (m.costUsd / max) * (H - PAD_TOP - PAD_BOTTOM) || 0;
        const y = H - PAD_BOTTOM - h;
        return (
          <g key={m.month}>
            <rect
              x={cx - barW / 2}
              y={y}
              width={barW}
              height={h}
              className="fill-primary/70"
              rx="2"
            />
            <text
              x={cx}
              y={H - PAD_BOTTOM + 14}
              className="fill-muted-foreground"
              textAnchor="middle"
              fontSize="10"
            >
              {m.month}
            </text>
            {m.costUsd > 0 && (
              <text
                x={cx}
                y={y - 4}
                className="fill-foreground"
                textAnchor="middle"
                fontSize="10"
              >
                ${m.costUsd.toFixed(0)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/** Read a prom-client counter/gauge value in-process, summing matching-label series. */
export interface ReadableMetric {
  get: () => Promise<{ values: Array<{ value: number; labels: Record<string, string | number> }> }>;
}

export async function counterValue(metric: ReadableMetric, match: Record<string, string> = {}): Promise<number> {
  const snap = await metric.get();
  let total = 0;
  for (const v of snap.values) {
    const ok = Object.entries(match).every(([k, val]) => String(v.labels[k]) === val);
    if (ok) total += v.value;
  }
  return total;
}

/** Run `fn` and return the increase in the metric value across it. */
export async function counterDelta(
  metric: ReadableMetric,
  match: Record<string, string>,
  fn: () => Promise<void>,
): Promise<number> {
  const before = await counterValue(metric, match);
  await fn();
  const after = await counterValue(metric, match);
  return after - before;
}

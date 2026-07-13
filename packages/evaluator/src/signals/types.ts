export interface UsageRow {
  requestId: string;
  requestedModel: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalCost: number | string;
}

export interface BodyRow {
  requestId: string;
  stopReason: string | null;
  clientUserAgent: string | null;
  clientSessionId: string | null;
  requestParams: unknown;
  responseBody: unknown;
  requestBody: unknown;
}

export interface Evidence {
  requestId?: string;
  quote: string;
  offset: number;
}

export interface SignalResult {
  hit: boolean;
  value?: number;
  evidence: Evidence[];
  /** v2: number of rows that actually carried data for this signal. */
  sampleCount?: number;
}

export interface KeywordInput {
  body: string;
  terms: string[];
  caseSensitive?: boolean;
  requestId?: string;
}

export interface ThresholdInput {
  metricValue: number;
  gte?: number;
  lte?: number;
  between?: readonly [number, number];
}

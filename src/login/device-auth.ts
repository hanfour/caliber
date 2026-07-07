export interface DeviceAuthStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  interval: number;
  expires_in: number;
}

export interface DeviceMeta {
  hostname: string;
  os: string;
  agentVersion: string;
  cliVersion: string;
}

function base(serverUrl: string): string {
  return serverUrl.replace(/\/$/, "");
}

// Node's fetch has NO default timeout — a connection that stalls after the
// handshake would otherwise hang the CLI forever (and, inside the poll
// loop, silently bypass the expires_in deadline, which is only checked
// between requests).
const REQUEST_TIMEOUT_MS = 10_000;

export async function startDeviceAuth(
  serverUrl: string,
  meta: DeviceMeta,
  opts?: { provisionGateway?: boolean },
): Promise<DeviceAuthStart> {
  const res = await fetch(`${base(serverUrl)}/v1/device-auth/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(
      opts?.provisionGateway ? { ...meta, provision_gateway: true } : meta,
    ),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (res.status !== 201) {
    throw new Error(`device-auth start failed (HTTP ${res.status})`);
  }
  return (await res.json()) as DeviceAuthStart;
}

export interface PollOpts {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface ApprovedResult {
  enrollmentToken: string;
  /** Present only when --gateway provisioning was requested and fulfilled. */
  apiKey?: string;
  gatewayUrl?: string;
}

interface PollBody {
  error?: string;
  enrollment_token?: string;
  api_key?: string;
  gateway_url?: string;
}

export async function pollUntilApproved(
  serverUrl: string,
  start: DeviceAuthStart,
  opts: PollOpts = {},
): Promise<ApprovedResult> {
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const deadline = now() + start.expires_in * 1000;
  const intervalMs = Math.max(0, start.interval * 1000);
  for (;;) {
    // A transient hiccup anywhere in the up-to-15-minute window (proxy
    // 502 HTML page during a deploy, dropped connection, request timeout)
    // must NOT abort the login — swallow it and let the next poll retry.
    // Only the server's terminal errors and the deadline end the loop.
    let status: number | null = null;
    let body: PollBody | null = null;
    try {
      const res = await fetch(`${base(serverUrl)}/v1/device-auth/poll`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ device_code: start.device_code }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      status = res.status;
      body = (await res.json()) as PollBody;
    } catch {
      // transport/parse failure → retry below (subject to the deadline)
    }
    if (body) {
      if (status === 200 && body.enrollment_token)
        return {
          enrollmentToken: body.enrollment_token,
          apiKey: body.api_key,
          gatewayUrl: body.gateway_url,
        };
      if (body.error === "access_denied") throw new Error("Authorization was denied on the dashboard.");
      if (body.error === "expired_token") throw new Error("The login request expired. Run `caliber login` again.");
    }
    // authorization_pending / slow_down / transient failure → wait and retry
    if (now() >= deadline) throw new Error("The login request expired. Run `caliber login` again.");
    await sleep(intervalMs);
  }
}

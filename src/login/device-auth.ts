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

export async function startDeviceAuth(serverUrl: string, meta: DeviceMeta): Promise<DeviceAuthStart> {
  const res = await fetch(`${base(serverUrl)}/v1/device-auth/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(meta),
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

export async function pollUntilApproved(
  serverUrl: string,
  start: DeviceAuthStart,
  opts: PollOpts = {},
): Promise<string> {
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const deadline = now() + start.expires_in * 1000;
  const intervalMs = Math.max(0, start.interval * 1000);
  for (;;) {
    const res = await fetch(`${base(serverUrl)}/v1/device-auth/poll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_code: start.device_code }),
    });
    const body = (await res.json()) as { error?: string; enrollment_token?: string };
    if (res.status === 200 && body.enrollment_token) return body.enrollment_token;
    if (body.error === "access_denied") throw new Error("Authorization was denied on the dashboard.");
    if (body.error === "expired_token") throw new Error("The login request expired. Run `caliber login` again.");
    // authorization_pending / slow_down → wait and retry
    if (now() >= deadline) throw new Error("The login request expired. Run `caliber login` again.");
    await sleep(intervalMs);
  }
}

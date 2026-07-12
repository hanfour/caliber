import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import chalk from "chalk";
import { deriveApiBase } from "./login/commands.js";
import { loadCliState } from "./login/state.js";

export interface AddPoolOptions {
  org: string;
  name?: string;
  priority?: string;
  concurrency?: string;
  open?: boolean;
}

interface StartResponse {
  flow_id: string;
  auth_url: string;
  expires_in: number;
  org: { id: string; slug: string; name: string };
}

interface CompleteResponse {
  id: string;
  name: string;
  platform: "anthropic";
  type: "oauth";
  scope: "organization";
  status: "active";
}

function integerOption(
  value: string | undefined,
  fallback: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`${label} must be an integer.`);
  return parsed;
}

async function responseBody(response: Response): Promise<Record<string, unknown>> {
  return (await response.json().catch(() => ({}))) as Record<string, unknown>;
}

function apiError(status: number, body: Record<string, unknown>): Error {
  const code = typeof body.error === "string" ? body.error : `http_${status}`;
  if (status === 401) {
    return new Error("CLI authorization expired. Run `caliber login` again.");
  }
  if (status === 403) {
    return new Error("This account cannot create organization pool accounts.");
  }
  if (code === "anthropic_oauth_disabled") {
    return new Error("Anthropic OAuth is disabled on the server. Set ENABLE_ANTHROPIC_OAUTH=true and restart the API.");
  }
  if (code === "oauth_flow_expired") {
    return new Error("The OAuth flow expired. Run `caliber admin pool add` again.");
  }
  if (code === "invalid_oauth_callback") {
    return new Error("The pasted value is not the callback URL for this OAuth flow.");
  }
  if (code === "oauth_exchange_failed") {
    return new Error("Anthropic rejected or expired the authorization code. Start again.");
  }
  return new Error(`Unable to add the pool subscription (${code}).`);
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  spawnSync(command, [url], { stdio: "ignore" });
}

export async function addClaudeSubscriptionToPool(
  options: AddPoolOptions,
): Promise<CompleteResponse> {
  const state = loadCliState();
  if (!state?.accessToken) {
    throw new Error("Admin CLI authorization is missing. Run `caliber login` first.");
  }
  const apiBase = deriveApiBase(state.serverUrl);
  const headers = {
    authorization: `Bearer ${state.accessToken}`,
    "content-type": "application/json",
  };
  const start = await fetch(`${apiBase}/v1/cli/admin/pool/oauth/start`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      org: options.org,
      name: options.name ?? "Claude subscription pool",
      priority: integerOption(options.priority, 50, "--priority"),
      concurrency: integerOption(options.concurrency, 20, "--concurrency"),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const startBody = await responseBody(start);
  if (!start.ok) throw apiError(start.status, startBody);
  const authorization = startBody as unknown as StartResponse;
  if (!authorization.flow_id || !authorization.auth_url) {
    throw new Error("Server returned an invalid OAuth authorization response.");
  }

  process.stderr.write(`\n${chalk.bold("Authorize Claude subscription")}\n`);
  process.stderr.write(`${authorization.auth_url}\n\n`);
  process.stderr.write(
    chalk.dim(
      "After approval, localhost may show connection refused. Copy the full URL from the browser address bar.\n",
    ),
  );
  if (options.open !== false) openBrowser(authorization.auth_url);

  const readline = createInterface({ input: process.stdin, output: process.stderr });
  let pastedValue: string;
  try {
    pastedValue = await readline.question("Paste callback URL: ");
  } finally {
    readline.close();
  }
  if (pastedValue.trim() === "") throw new Error("Callback URL is required.");

  const complete = await fetch(`${apiBase}/v1/cli/admin/pool/oauth/complete`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      flow_id: authorization.flow_id,
      pasted_value: pastedValue.trim(),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const completeBody = await responseBody(complete);
  if (!complete.ok) throw apiError(complete.status, completeBody);
  const account = completeBody as unknown as CompleteResponse;
  if (!account.id || account.scope !== "organization") {
    throw new Error("Server returned an invalid pool account response.");
  }

  process.stderr.write(
    `${chalk.green("Added Claude subscription to shared pool:")} ${account.name}\n`,
  );
  process.stderr.write(chalk.dim(`Account ID: ${account.id}\n`));
  return account;
}

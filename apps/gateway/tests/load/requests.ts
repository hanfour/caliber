/** POST /v1/messages with an api key; returns {status, json, text}. */
export async function postMessages(
  baseUrl: string, rawKey: string,
  body: Record<string, unknown> = { model: "claude-3-haiku-20240307", max_tokens: 10, messages: [{ role: "user", content: "hi" }] },
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; json: any; text: string }> {
  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${rawKey}`, "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* SSE or empty */ }
  return { status: res.status, json, text };
}

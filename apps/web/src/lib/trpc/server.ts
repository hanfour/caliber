import "server-only";
import { cookies } from "next/headers";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { AppRouter } from "@caliber/api-types";

export async function serverTrpc() {
  const internalUrl = process.env.API_INTERNAL_URL ?? "http://localhost:3001";
  const cookieHeader = (await cookies())
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${internalUrl}/trpc`,
        headers: () => ({ cookie: cookieHeader }),
      }),
    ],
  });
}

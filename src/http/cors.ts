import { cors } from "hono/cors";
import {
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
} from "../domain/x402.js";

/**
 * Loopback Vite origins used by [berth-web](https://github.com/hexuria/berth-web).
 * Default is this list — never `*`.
 */
export const DEFAULT_CORS_ORIGINS = [
  "http://127.0.0.1:5173",
  "http://127.0.0.1:5174",
  "http://localhost:5173",
  "http://localhost:5174",
] as const;

/** Parse `CORS_ORIGIN` (comma list). Unset / empty → Vite loopback defaults. */
export function parseCorsOrigins(value: string | undefined): string[] {
  if (value === undefined) return [...DEFAULT_CORS_ORIGINS];
  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length === 0 ? [...DEFAULT_CORS_ORIGINS] : parts;
}

export function isWildcardCors(origins: readonly string[]): boolean {
  return origins.some((origin) => origin === "*");
}

export function corsMiddleware(origins: readonly string[]) {
  const allowAll = isWildcardCors(origins);
  return cors({
    origin: allowAll
      ? "*"
      : (origin) => (origin && origins.includes(origin) ? origin : null),
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: [
      "Content-Type",
      "Authorization",
      PAYMENT_SIGNATURE_HEADER,
      PAYMENT_REQUIRED_HEADER,
    ],
    exposeHeaders: [PAYMENT_REQUIRED_HEADER, PAYMENT_RESPONSE_HEADER],
    maxAge: 600,
    credentials: false,
  });
}

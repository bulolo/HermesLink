import type { Context } from "koa";

export function getRequiredString(ctx: Context, field: string): string | null {
  const body = ctx.request.body as Record<string, unknown> | null | undefined;
  if (!body || typeof body !== "object") {
    ctx.status = 400;
    ctx.body = { error: `Missing request body` };
    return null;
  }
  const value = body[field];
  if (typeof value !== "string" || !value.trim()) {
    ctx.status = 400;
    ctx.body = { error: `Missing or empty field: ${field}` };
    return null;
  }
  return value;
}

export function getOptionalString(
  body: Record<string, unknown>,
  field: string,
): string | null {
  const value = body[field];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function getOptionalNumber(
  body: Record<string, unknown>,
  field: string,
): number | null {
  const value = body[field];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function getOptionalBoolean(
  body: Record<string, unknown>,
  field: string,
): boolean | null {
  const value = body[field];
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

export function parseJsonBody(ctx: Context): Record<string, unknown> | null {
  const body = ctx.request.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    ctx.status = 400;
    ctx.body = { error: "Invalid JSON body" };
    return null;
  }
  return body as Record<string, unknown>;
}

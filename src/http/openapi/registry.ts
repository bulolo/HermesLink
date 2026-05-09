import { OpenAPIRegistry, OpenApiGeneratorV3, extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { LINK_DEFAULT_PORT } from "../../constants.js";

extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

registry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
  description: "Device access token (`hlat_` prefix) from /api/v1/auth/device-session",
});

// ─── Shared schemas ────────────────────────────────────────────────────────

const OkSchema = z.object({ ok: z.literal(true) });

const ErrorSchema = registry.register(
  "Error",
  z.object({
    ok: z.literal(false),
    error: z.object({
      code: z.string().openapi({ example: "internal_error" }),
      message: z.string().openapi({ example: "Internal server error" }),
    }),
  }),
);

const TokenSchema = z.object({
  token: z.string(),
  expires_at: z.string().openapi({ format: "date-time" }),
});

const DeviceSchema = registry.register(
  "Device",
  z.object({
    id: z.string(),
    device_id: z.string(),
    label: z.string(),
    platform: z.string(),
    model: z.string().nullable(),
    scope: z.string(),
  }),
);

const CronJobSchema = registry.register(
  "CronJob",
  z.object({
    id: z.string(),
    profile: z.string(),
    name: z.string(),
    schedule: z.string().openapi({ example: "0 9 * * *" }),
    enabled: z.boolean(),
    input: z.string().optional(),
  }),
);

const err = (description: string) => ({
  description,
  content: { "application/json": { schema: ErrorSchema } },
});

const auth = [{ bearerAuth: [] }];

const conversationId = z.object({ conversationId: z.string() });
const profileName = z.object({ name: z.string().openapi({ example: "default" }) });
const deviceId = z.object({ deviceId: z.string() });
const runId = z.object({ runId: z.string() });
const jobId = z.object({ name: z.string(), jobId: z.string() });

// ─── Bootstrap ────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/v1/bootstrap",
  summary: "Service discovery — no auth required",
  tags: ["Bootstrap"],
  responses: {
    200: {
      description: "Service info",
      content: {
        "application/json": {
          schema: z.object({
            link_id: z.string().nullable(),
            display_name: z.string(),
            version: z.string(),
            api_version: z.number(),
            paired: z.boolean(),
            preferred_pairing_urls: z.array(z.string()),
            capabilities: z.record(z.boolean()),
          }),
        },
      },
    },
  },
});

// ─── Status ───────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/v1/status",
  summary: "Overall service status",
  tags: ["Status"],
  security: auth,
  responses: {
    200: {
      description: "Status",
      content: {
        "application/json": {
          schema: z.object({
            ok: z.literal(true),
            version: z.string(),
            paired: z.boolean(),
            link_id: z.string().nullable(),
            port: z.number(),
            link: z.object({ state: z.string(), version: z.string(), update_available: z.boolean() }),
            hermes: z.object({ local_version: z.string().nullable(), update_available: z.boolean() }),
            gateway: z.object({ state: z.string(), issue: z.string().nullable() }),
            api_server: z.object({ state: z.string(), issue: z.string().nullable() }),
            devices: z.object({ total: z.number(), trusted: z.number() }),
            profiles: z.object({ total: z.number() }),
          }),
        },
      },
    },
    401: err("Unauthorized"),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/logs",
  summary: "Recent log entries",
  tags: ["Status"],
  security: auth,
  request: {
    query: z.object({
      source: z.enum(["link", "gateway"]).optional().openapi({ example: "link" }),
      limit: z.string().optional().openapi({ example: "50" }),
    }),
  },
  responses: {
    200: {
      description: "Log entries",
      content: { "application/json": { schema: z.object({ ok: z.literal(true), source: z.string(), logs: z.array(z.unknown()) }) } },
    },
    401: err("Unauthorized"),
  },
});

// ─── Auth ─────────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/v1/auth/me",
  summary: "Get current auth context and device info",
  tags: ["Auth"],
  security: auth,
  responses: {
    200: {
      description: "Auth context",
      content: {
        "application/json": {
          schema: z.object({
            ok: z.literal(true),
            auth: z.object({ kind: z.string(), account_id: z.string().nullable() }),
            link: z.object({ link_id: z.string(), display_name: z.string() }),
            device: DeviceSchema.nullable(),
          }),
        },
      },
    },
    401: err("Unauthorized"),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/auth/device-session",
  summary: "Exchange connect token for access + refresh tokens",
  description: "The `Authorization` header must carry the **connect token** (not an `hlat_` token).",
  tags: ["Auth"],
  security: auth,
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            device_label: z.string().optional().openapi({ example: "HermesPilot App" }),
            device_platform: z.string().optional().openapi({ example: "ios" }),
            device_model: z.string().optional().openapi({ example: "iPhone 16" }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Session created",
      content: {
        "application/json": {
          schema: z.object({
            ok: z.literal(true),
            link: z.object({ link_id: z.string(), display_name: z.string() }),
            device: DeviceSchema,
            access_token: TokenSchema,
            refresh_token: TokenSchema,
          }),
        },
      },
    },
    401: err("Invalid connect token"),
    409: err("Link not paired"),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/auth/refresh",
  summary: "Refresh access token",
  tags: ["Auth"],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: z.object({ refresh_token: z.string() }) } },
    },
  },
  responses: {
    200: {
      description: "Tokens refreshed",
      content: {
        "application/json": {
          schema: z.object({ ok: z.literal(true), device: DeviceSchema, access_token: TokenSchema, refresh_token: TokenSchema }),
        },
      },
    },
    401: err("Invalid or expired refresh token"),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/auth/logout",
  summary: "Revoke device session",
  tags: ["Auth"],
  request: {
    body: {
      content: { "application/json": { schema: z.object({ refresh_token: z.string().optional() }) } },
    },
  },
  responses: { 200: { description: "Logged out", content: { "application/json": { schema: OkSchema } } } },
});

// ─── Pairing ──────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/v1/pairing/session",
  summary: "Query pairing session status",
  tags: ["Pairing"],
  request: { query: z.object({ session_id: z.string() }) },
  responses: {
    200: {
      description: "Session info",
      content: {
        "application/json": {
          schema: z.object({
            ok: z.literal(true),
            session: z.object({
              session_id: z.string(),
              link_id: z.string(),
              display_name: z.string(),
              local_api_url: z.string(),
              preferred_urls: z.array(z.string()),
              created_at: z.string(),
              expires_at: z.string(),
              claimed: z.boolean(),
            }),
          }),
        },
      },
    },
    400: err("session_id is required"),
    404: err("Session not found or expired"),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/pairing/claim",
  summary: "Claim a pairing session (app side)",
  tags: ["Pairing"],
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            session_id: z.string(),
            claim_token: z.string(),
            device_label: z.string().optional().openapi({ example: "HermesPilot App" }),
            device_platform: z.string().optional().openapi({ example: "ios" }),
            device_model: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Pairing claimed — returns tokens",
      content: {
        "application/json": {
          schema: z.object({
            ok: z.literal(true),
            link: z.object({ link_id: z.string(), display_name: z.string() }),
            device: DeviceSchema,
            access_token: TokenSchema,
            refresh_token: TokenSchema,
          }),
        },
      },
    },
    404: err("Session not found or expired"),
    409: err("Token mismatch or link not paired"),
  },
});

// ─── Devices ──────────────────────────────────────────────────────────────

const DeviceListResponseSchema = z.object({
  ok: z.literal(true),
  current_device_id: z.string().nullable(),
  devices: z.array(DeviceSchema.extend({ current: z.boolean() })),
  summary: z.object({ total: z.number(), trusted: z.number() }),
});

registry.registerPath({
  method: "get",
  path: "/api/v1/devices",
  summary: "List all paired devices",
  tags: ["Devices"],
  security: auth,
  responses: {
    200: { description: "Device list", content: { "application/json": { schema: DeviceListResponseSchema } } },
    401: err("Unauthorized"),
  },
});

registry.registerPath({
  method: "patch",
  path: "/api/v1/devices/{deviceId}",
  summary: "Rename a device",
  tags: ["Devices"],
  security: auth,
  request: {
    params: deviceId,
    body: {
      required: true,
      content: { "application/json": { schema: z.object({ label: z.string() }) } },
    },
  },
  responses: {
    200: {
      description: "Device renamed",
      content: {
        "application/json": { schema: z.object({ ok: z.literal(true), device: DeviceSchema.extend({ current: z.boolean() }) }) },
      },
    },
    401: err("Unauthorized"),
    404: err("Device not found"),
  },
});

registry.registerPath({
  method: "delete",
  path: "/api/v1/devices/{deviceId}",
  summary: "Revoke a device (invalidates its tokens)",
  tags: ["Devices"],
  security: auth,
  request: { params: deviceId },
  responses: {
    200: {
      description: "Device revoked",
      content: {
        "application/json": {
          schema: z.object({
            ok: z.literal(true),
            current_device_revoked: z.boolean(),
            device: DeviceSchema.extend({ current: z.boolean() }),
            summary: z.object({ total: z.number(), trusted: z.number() }),
          }),
        },
      },
    },
    401: err("Unauthorized"),
    404: err("Device not found"),
  },
});

registry.registerPath({
  method: "delete",
  path: "/api/v1/devices/{deviceId}/app-listing",
  summary: "Hide a revoked device from the app list",
  tags: ["Devices"],
  security: auth,
  request: { params: deviceId },
  responses: {
    200: { description: "Hidden", content: { "application/json": { schema: OkSchema } } },
    401: err("Unauthorized"),
    404: err("Device not found"),
  },
});

// ─── Conversations ────────────────────────────────────────────────────────

const MessageSchema = registry.register(
  "Message",
  z.object({
    id: z.string(),
    role: z.enum(["user", "assistant"]),
    content: z.string(),
    created_at: z.string().openapi({ format: "date-time" }),
  }),
);

const ConversationProfileSchema = z.object({
  name: z.string(),
  display_name: z.string(),
  avatar_url: z.string().nullable(),
});

const ConversationUsageSchema = z.object({
  input_tokens: z.number(),
  output_tokens: z.number(),
  total_tokens: z.number(),
});

const ConversationSchema = registry.register(
  "Conversation",
  z.object({
    id: z.string().openapi({ example: "conv_xxx" }),
    title: z.string().nullable(),
    profile: ConversationProfileSchema,
    usage: ConversationUsageSchema,
    last_message: z.unknown().nullable(),
    last_event_seq: z.number(),
    created_at: z.string().openapi({ format: "date-time" }),
    updated_at: z.string().openapi({ format: "date-time" }),
  }),
);

const PlanSchema = z.object({
  id: z.string(),
  status: z.string().openapi({ example: "prepared" }),
  total_count: z.number(),
  conversation_ids: z.array(z.string()),
});

const convListQuery = z.object({
  limit: z.string().optional().openapi({ example: "20" }),
  cursor: z.string().optional(),
  profile: z.string().optional(),
});

const convListResponse = z.object({
  ok: z.literal(true),
  conversations: z.array(ConversationSchema),
  page: z.object({ limit: z.number(), has_more: z.boolean(), next_cursor: z.string().nullable() }),
});

registry.registerPath({
  method: "get",
  path: "/api/v1/conversations",
  summary: "List active conversations",
  tags: ["Conversations"],
  security: auth,
  request: { query: convListQuery },
  responses: {
    200: { description: "Conversation list", content: { "application/json": { schema: convListResponse } } },
    401: err("Unauthorized"),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/conversations",
  summary: "Create a new conversation",
  tags: ["Conversations"],
  security: auth,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ title: z.string().optional(), profile: z.string().optional(), model: z.string().optional() }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Conversation created",
      content: { "application/json": { schema: z.object({ ok: z.literal(true), conversation: ConversationSchema }) } },
    },
    401: err("Unauthorized"),
  },
});

registry.registerPath({
  method: "delete",
  path: "/api/v1/conversations",
  summary: "Bulk delete conversations",
  tags: ["Conversations"],
  security: auth,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ conversation_ids: z.array(z.string()).optional() }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Deleted",
      content: {
        "application/json": {
          schema: z.object({ ok: z.literal(true), deleted_count: z.number(), failed_count: z.number(), conversations: z.array(z.unknown()) }),
        },
      },
    },
    401: err("Unauthorized"),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/conversations/search",
  summary: "Search active conversations by keyword",
  tags: ["Conversations"],
  security: auth,
  request: { query: z.object({ q: z.string(), limit: z.string().optional() }) },
  responses: {
    200: {
      description: "Search results",
      content: { "application/json": { schema: z.object({ ok: z.literal(true), conversations: z.array(ConversationSchema) }) } },
    },
    401: err("Unauthorized"),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/conversations/archived",
  summary: "List archived conversations",
  tags: ["Conversations"],
  security: auth,
  request: { query: convListQuery },
  responses: {
    200: { description: "Archived conversations", content: { "application/json": { schema: convListResponse } } },
    401: err("Unauthorized"),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/conversations/archived/search",
  summary: "Search archived conversations by keyword",
  tags: ["Conversations"],
  security: auth,
  request: { query: z.object({ q: z.string(), limit: z.string().optional() }) },
  responses: {
    200: {
      description: "Search results",
      content: { "application/json": { schema: z.object({ ok: z.literal(true), conversations: z.array(ConversationSchema) }) } },
    },
    401: err("Unauthorized"),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/conversations/events",
  summary: "SSE stream for all conversation events",
  tags: ["Conversations"],
  security: auth,
  responses: { 200: { description: "SSE stream (text/event-stream)" }, 401: err("Unauthorized") },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/conversations/{conversationId}/messages",
  summary: "Get messages in a conversation",
  tags: ["Conversations"],
  security: auth,
  request: {
    params: conversationId,
    query: z.object({ limit: z.string().optional(), cursor: z.string().optional() }),
  },
  responses: {
    200: {
      description: "Messages + runtime + pagination",
      content: {
        "application/json": {
          schema: z.object({
            ok: z.literal(true),
            messages: z.array(MessageSchema),
            last_event_seq: z.number(),
            runtime: z.object({
              profile: z.object({ name: z.string(), display_name: z.string() }),
              model: z.object({ id: z.string() }),
              context: z.object({ input_tokens: z.number(), source: z.string() }),
            }),
            page: z.object({ has_more_before: z.boolean(), has_more_after: z.boolean() }),
          }),
        },
      },
    },
    401: err("Unauthorized"),
    404: err("Conversation not found"),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/conversations/{conversationId}/messages",
  summary: "Send a message",
  tags: ["Conversations"],
  security: auth,
  request: {
    params: conversationId,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({ content: z.string(), role: z.enum(["user", "assistant"]).optional() }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Message sent",
      content: { "application/json": { schema: z.object({ ok: z.literal(true), message: MessageSchema }) } },
    },
    401: err("Unauthorized"),
    404: err("Conversation not found"),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/conversations/{conversationId}/events",
  summary: "SSE event stream for a single conversation",
  tags: ["Conversations"],
  security: auth,
  request: { params: conversationId, query: z.object({ after: z.string().optional() }) },
  responses: { 200: { description: "SSE stream" }, 401: err("Unauthorized") },
});

registry.registerPath({
  method: "patch",
  path: "/api/v1/conversations/{conversationId}/title",
  summary: "Rename conversation",
  tags: ["Conversations"],
  security: auth,
  request: {
    params: conversationId,
    body: { required: true, content: { "application/json": { schema: z.object({ title: z.string() }) } } },
  },
  responses: {
    200: {
      description: "Updated",
      content: {
        "application/json": {
          schema: z.object({
            ok: z.literal(true),
            conversation_id: z.string(),
            title: z.string(),
            conversation: ConversationSchema,
            last_event_seq: z.number(),
            hermes_synced: z.boolean(),
          }),
        },
      },
    },
    401: err("Unauthorized"),
  },
});

registry.registerPath({
  method: "patch",
  path: "/api/v1/conversations/{conversationId}/model",
  summary: "Switch model for a conversation",
  tags: ["Conversations"],
  security: auth,
  request: {
    params: conversationId,
    body: { required: true, content: { "application/json": { schema: z.object({ model_id: z.string() }) } } },
  },
  responses: {
    200: {
      description: "Updated",
      content: {
        "application/json": {
          schema: z.object({
            ok: z.literal(true),
            conversation_id: z.string(),
            model_override: z.string(),
            runtime: z.unknown(),
            last_event_seq: z.number(),
          }),
        },
      },
    },
    401: err("Unauthorized"),
  },
});

registry.registerPath({
  method: "patch",
  path: "/api/v1/conversations/{conversationId}/profile",
  summary: "Switch profile for a conversation",
  tags: ["Conversations"],
  security: auth,
  request: {
    params: conversationId,
    body: { required: true, content: { "application/json": { schema: z.object({ profile: z.string() }) } } },
  },
  responses: {
    200: {
      description: "Updated",
      content: {
        "application/json": {
          schema: z.object({
            ok: z.literal(true),
            conversation_id: z.string(),
            profile: ConversationProfileSchema,
            runtime: z.unknown(),
            conversation: ConversationSchema,
            last_event_seq: z.number(),
          }),
        },
      },
    },
    401: err("Unauthorized"),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/conversations/{conversationId}/ack",
  summary: "Acknowledge events as read",
  tags: ["Conversations"],
  security: auth,
  request: { params: conversationId },
  responses: { 200: { description: "Acknowledged", content: { "application/json": { schema: OkSchema } } }, 401: err("Unauthorized") },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/conversations/{conversationId}/archive",
  summary: "Archive a conversation",
  tags: ["Conversations"],
  security: auth,
  request: { params: conversationId },
  responses: {
    200: {
      description: "Archived",
      content: {
        "application/json": {
          schema: z.object({ ok: z.literal(true), conversation_id: z.string(), archived_at: z.string() }),
        },
      },
    },
    401: err("Unauthorized"),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/conversations/{conversationId}/unarchive",
  summary: "Unarchive a conversation",
  tags: ["Conversations"],
  security: auth,
  request: { params: conversationId },
  responses: {
    200: {
      description: "Unarchived",
      content: {
        "application/json": {
          schema: z.object({ ok: z.literal(true), conversation_id: z.string(), unarchived_at: z.string() }),
        },
      },
    },
    401: err("Unauthorized"),
  },
});

registry.registerPath({
  method: "delete",
  path: "/api/v1/conversations/{conversationId}",
  summary: "Delete a conversation",
  tags: ["Conversations"],
  security: auth,
  request: { params: conversationId },
  responses: {
    200: {
      description: "Deleted",
      content: {
        "application/json": {
          schema: z.object({ ok: z.literal(true), conversation_id: z.string(), hermes_deleted: z.boolean(), deleted_at: z.string() }),
        },
      },
    },
    401: err("Unauthorized"),
    404: err("Not found"),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/conversations/{conversationId}/runs/{runId}/cancel",
  summary: "Cancel an in-progress run in a conversation",
  tags: ["Conversations"],
  security: auth,
  request: { params: z.object({ conversationId: z.string(), runId: z.string() }) },
  responses: { 200: { description: "Cancelled", content: { "application/json": { schema: OkSchema } } }, 401: err("Unauthorized") },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/conversations/{conversationId}/approvals/{approvalId}/approve",
  summary: "Approve a tool call",
  tags: ["Conversations"],
  security: auth,
  request: { params: z.object({ conversationId: z.string(), approvalId: z.string() }) },
  responses: { 200: { description: "Approved", content: { "application/json": { schema: OkSchema } } }, 401: err("Unauthorized") },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/conversations/{conversationId}/approvals/{approvalId}/deny",
  summary: "Deny a tool call",
  tags: ["Conversations"],
  security: auth,
  request: { params: z.object({ conversationId: z.string(), approvalId: z.string() }) },
  responses: { 200: { description: "Denied", content: { "application/json": { schema: OkSchema } } }, 401: err("Unauthorized") },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/conversations/{conversationId}/blobs",
  summary: "Upload an attachment",
  tags: ["Conversations"],
  security: auth,
  request: { params: conversationId },
  responses: {
    200: {
      description: "Uploaded",
      content: { "application/json": { schema: z.object({ ok: z.literal(true), blob_id: z.string() }) } },
    },
    401: err("Unauthorized"),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/conversations/{conversationId}/blobs/{blobId}",
  summary: "Download an attachment",
  tags: ["Conversations"],
  security: auth,
  request: { params: z.object({ conversationId: z.string(), blobId: z.string() }) },
  responses: { 200: { description: "File content" }, 401: err("Unauthorized"), 404: err("Not found") },
});

registry.registerPath({
  method: "delete",
  path: "/api/v1/conversations/{conversationId}/blobs/{blobId}",
  summary: "Delete an attachment",
  tags: ["Conversations"],
  security: auth,
  request: { params: z.object({ conversationId: z.string(), blobId: z.string() }) },
  responses: { 200: { description: "Deleted", content: { "application/json": { schema: OkSchema } } }, 401: err("Unauthorized") },
});

// Archive plans

registry.registerPath({
  method: "post",
  path: "/api/v1/conversations/archive-plans",
  summary: "Create a bulk-archive plan",
  tags: ["Conversations"],
  security: auth,
  request: {
    body: { content: { "application/json": { schema: z.object({ profile: z.string().optional() }) } } },
  },
  responses: {
    201: {
      description: "Plan created",
      content: {
        "application/json": {
          schema: z.object({ ok: z.literal(true), plan: PlanSchema.extend({ archived_count: z.number() }) }),
        },
      },
    },
    401: err("Unauthorized"),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/conversations/archive-plans/{planId}",
  summary: "Get archive plan status",
  tags: ["Conversations"],
  security: auth,
  request: { params: z.object({ planId: z.string() }) },
  responses: {
    200: {
      description: "Plan",
      content: {
        "application/json": {
          schema: z.object({ ok: z.literal(true), plan: PlanSchema.extend({ archived_count: z.number() }) }),
        },
      },
    },
    401: err("Unauthorized"),
    404: err("Plan not found"),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/conversations/archive-plans/{planId}/execute",
  summary: "Execute an archive plan",
  tags: ["Conversations"],
  security: auth,
  request: { params: z.object({ planId: z.string() }) },
  responses: {
    200: {
      description: "Executed",
      content: {
        "application/json": {
          schema: z.object({ ok: z.literal(true), plan: PlanSchema.extend({ archived_count: z.number() }) }),
        },
      },
    },
    401: err("Unauthorized"),
  },
});

// Clear plans

registry.registerPath({
  method: "post",
  path: "/api/v1/conversations/clear-plans",
  summary: "Create a bulk-delete plan",
  tags: ["Conversations"],
  security: auth,
  request: {
    body: { content: { "application/json": { schema: z.object({ profile: z.string().optional(), older_than_days: z.number().optional() }) } } },
  },
  responses: {
    201: {
      description: "Plan created",
      content: {
        "application/json": {
          schema: z.object({ ok: z.literal(true), plan: PlanSchema }),
        },
      },
    },
    401: err("Unauthorized"),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/conversations/clear-plans/{planId}",
  summary: "Get clear plan status",
  tags: ["Conversations"],
  security: auth,
  request: { params: z.object({ planId: z.string() }) },
  responses: {
    200: {
      description: "Plan",
      content: { "application/json": { schema: z.object({ ok: z.literal(true), plan: PlanSchema }) } },
    },
    401: err("Unauthorized"),
    404: err("Plan not found"),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/conversations/clear-plans/{planId}/execute",
  summary: "Execute a clear plan",
  tags: ["Conversations"],
  security: auth,
  request: { params: z.object({ planId: z.string() }) },
  responses: {
    200: {
      description: "Executed",
      content: {
        "application/json": {
          schema: z.object({
            ok: z.literal(true),
            plan: PlanSchema.extend({ deleted_count: z.number(), conversations: z.array(z.unknown()) }),
          }),
        },
      },
    },
    401: err("Unauthorized"),
  },
});

// ─── Statistics ───────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/v1/statistics",
  summary: "Global usage statistics (conversation and message counts)",
  tags: ["Statistics"],
  security: auth,
  request: {
    query: z.object({ profile: z.string().optional(), profile_uid: z.string().optional() }),
  },
  responses: {
    200: { description: "Statistics", content: { "application/json": { schema: z.object({ ok: z.literal(true), statistics: z.record(z.unknown()) }) } } },
    401: err("Unauthorized"),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/statistics/usage",
  summary: "Token usage by date / model / profile",
  tags: ["Statistics"],
  security: auth,
  request: {
    query: z.object({
      days: z.string().optional().openapi({ example: "7" }),
      from: z.string().optional().openapi({ example: "2026-05-01" }),
      to: z.string().optional().openapi({ example: "2026-05-09" }),
      model: z.string().optional(),
      profile: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "Usage breakdown",
      content: {
        "application/json": {
          schema: z.object({
            ok: z.literal(true),
            usage: z.object({
              range: z.object({ from: z.string(), to: z.string(), days: z.number() }),
              totals: z.object({ input_tokens: z.number(), output_tokens: z.number(), total_tokens: z.number(), run_count: z.number() }),
              daily: z.array(z.object({ date: z.string(), total_tokens: z.number(), run_count: z.number() })),
              models: z.array(z.object({ model: z.string(), total_tokens: z.number(), run_count: z.number() })),
              profiles: z.array(z.object({ profile: z.string(), total_tokens: z.number(), run_count: z.number() })),
            }),
          }),
        },
      },
    },
    401: err("Unauthorized"),
  },
});

// ─── Models ───────────────────────────────────────────────────────────────

const ModelConfigBody = z.object({
  id: z.string().openapi({ example: "gpt-4o" }),
  provider: z.string().openapi({ example: "openai" }),
  base_url: z.string().openapi({ example: "https://api.openai.com/v1" }),
  api_key: z.string().optional(),
  context_length: z.number().optional(),
  set_default: z.boolean().optional(),
});

registry.registerPath({
  method: "get",
  path: "/api/v1/models",
  summary: "List available models (OpenAI-compatible format)",
  tags: ["Models"],
  security: auth,
  request: { query: z.object({ profile: z.string().optional() }) },
  responses: {
    200: { description: "Model list", content: { "application/json": { schema: z.unknown() } } },
    401: err("Unauthorized"),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/model-configs",
  summary: "List global model configs",
  tags: ["Models"],
  security: auth,
  responses: {
    200: { description: "Model configs", content: { "application/json": { schema: z.unknown() } } },
    401: err("Unauthorized"),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/model-configs",
  summary: "Add a global model config",
  tags: ["Models"],
  security: auth,
  request: { body: { required: true, content: { "application/json": { schema: ModelConfigBody } } } },
  responses: {
    200: { description: "Saved", content: { "application/json": { schema: z.unknown() } } },
    400: err("Invalid model config"),
    401: err("Unauthorized"),
  },
});

registry.registerPath({
  method: "patch",
  path: "/api/v1/model-configs/defaults",
  summary: "Update global default model",
  tags: ["Models"],
  security: auth,
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: z.object({ task_model_id: z.string().optional(), compression_model_id: z.string().optional() }) } },
    },
  },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: z.unknown() } } },
    401: err("Unauthorized"),
  },
});

registry.registerPath({
  method: "delete",
  path: "/api/v1/model-configs",
  summary: "Delete a global model config",
  tags: ["Models"],
  security: auth,
  request: { body: { required: true, content: { "application/json": { schema: z.object({ model_id: z.string() }) } } } },
  responses: {
    200: { description: "Deleted", content: { "application/json": { schema: z.unknown() } } },
    400: err("model_id required"),
    401: err("Unauthorized"),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/profiles/{name}/model-configs",
  summary: "List model configs for a profile",
  tags: ["Models"],
  security: auth,
  request: { params: profileName },
  responses: { 200: { description: "Model configs", content: { "application/json": { schema: z.unknown() } } }, 401: err("Unauthorized") },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/profiles/{name}/model-configs",
  summary: "Add model config to a profile",
  tags: ["Models"],
  security: auth,
  request: { params: profileName, body: { required: true, content: { "application/json": { schema: ModelConfigBody } } } },
  responses: { 200: { description: "Saved", content: { "application/json": { schema: z.unknown() } } }, 401: err("Unauthorized") },
});

registry.registerPath({
  method: "patch",
  path: "/api/v1/profiles/{name}/model-configs/defaults",
  summary: "Update default model for a profile",
  tags: ["Models"],
  security: auth,
  request: {
    params: profileName,
    body: { required: true, content: { "application/json": { schema: z.object({ task_model_id: z.string().optional(), compression_model_id: z.string().optional() }) } } },
  },
  responses: { 200: { description: "Updated", content: { "application/json": { schema: z.unknown() } } }, 401: err("Unauthorized") },
});

registry.registerPath({
  method: "delete",
  path: "/api/v1/profiles/{name}/model-configs",
  summary: "Delete a model config from a profile",
  tags: ["Models"],
  security: auth,
  request: { params: profileName, body: { required: true, content: { "application/json": { schema: z.object({ model_id: z.string() }) } } } },
  responses: { 200: { description: "Deleted", content: { "application/json": { schema: z.unknown() } } }, 401: err("Unauthorized") },
});

// ─── Profiles ─────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/v1/profiles",
  summary: "List all profile names",
  tags: ["Profiles"],
  security: auth,
  responses: {
    200: { description: "Profile list", content: { "application/json": { schema: z.object({ ok: z.literal(true), profiles: z.array(z.string()) }) } } },
    401: err("Unauthorized"),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/profiles",
  summary: "Start profile creation (async, returns 202)",
  tags: ["Profiles"],
  security: auth,
  request: {
    body: { content: { "application/json": { schema: z.object({ name: z.string(), display_name: z.string().optional() }) } } },
  },
  responses: {
    202: { description: "Creation started", content: { "application/json": { schema: z.unknown() } } },
    401: err("Unauthorized"),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/profiles/catalog",
  summary: "Full catalog — capabilities, permissions, model configs per profile",
  tags: ["Profiles"],
  security: auth,
  responses: {
    200: { description: "Catalog", content: { "application/json": { schema: z.object({ ok: z.literal(true), generatedAt: z.string(), profiles: z.array(z.unknown()) }) } } },
    401: err("Unauthorized"),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/profile-creation/status",
  summary: "Query profile creation progress",
  tags: ["Profiles"],
  security: auth,
  responses: { 200: { description: "Status", content: { "application/json": { schema: z.unknown() } } }, 401: err("Unauthorized") },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/profile-creation/events",
  summary: "Profile creation progress SSE stream",
  tags: ["Profiles"],
  security: auth,
  responses: { 200: { description: "SSE stream" }, 401: err("Unauthorized") },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/profiles/{name}/status",
  summary: "Profile status (existence, API key config, etc.)",
  tags: ["Profiles"],
  security: auth,
  request: { params: profileName },
  responses: { 200: { description: "Profile status", content: { "application/json": { schema: z.unknown() } } }, 401: err("Unauthorized"), 404: err("Profile not found") },
});

registry.registerPath({
  method: "patch",
  path: "/api/v1/profiles/{name}",
  summary: "Rename profile or update metadata",
  tags: ["Profiles"],
  security: auth,
  request: {
    params: profileName,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().optional().openapi({ description: "New name — triggers rename" }),
            display_name: z.string().optional(),
            description: z.string().optional(),
            avatar_type: z.enum(["default", "url"]).optional(),
            avatar_url: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: { 200: { description: "Updated", content: { "application/json": { schema: z.unknown() } } }, 401: err("Unauthorized") },
});

registry.registerPath({
  method: "delete",
  path: "/api/v1/profiles/{name}",
  summary: "Delete a profile",
  tags: ["Profiles"],
  security: auth,
  request: { params: profileName },
  responses: { 204: { description: "Deleted" }, 401: err("Unauthorized"), 404: err("Profile not found") },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/profiles/{name}/statistics",
  summary: "Profile conversation statistics",
  tags: ["Profiles"],
  security: auth,
  request: { params: profileName },
  responses: { 200: { description: "Statistics", content: { "application/json": { schema: z.unknown() } } }, 401: err("Unauthorized") },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/profiles/{name}/skills",
  summary: "List profile skills",
  tags: ["Profiles"],
  security: auth,
  request: { params: profileName, query: z.object({ include_disabled: z.string().optional() }) },
  responses: { 200: { description: "Skills", content: { "application/json": { schema: z.unknown() } } }, 401: err("Unauthorized") },
});

registry.registerPath({
  method: "patch",
  path: "/api/v1/profiles/{name}/skills/{skillName}",
  summary: "Enable or disable a skill",
  tags: ["Profiles"],
  security: auth,
  request: {
    params: z.object({ name: z.string(), skillName: z.string() }),
    body: { required: true, content: { "application/json": { schema: z.object({ enabled: z.boolean() }) } } },
  },
  responses: { 200: { description: "Updated", content: { "application/json": { schema: z.unknown() } } }, 401: err("Unauthorized"), 404: err("Skill not found") },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/profiles/{name}/memory",
  summary: "View memory (USER.md + MEMORY.md)",
  tags: ["Profiles"],
  security: auth,
  request: { params: profileName },
  responses: { 200: { description: "Memory content", content: { "application/json": { schema: z.unknown() } } }, 401: err("Unauthorized") },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/profiles/{name}/memory/entries",
  summary: "Add a memory entry",
  description: "`target`: `\"memory\"` (MEMORY.md) or `\"user\"` (USER.md)",
  tags: ["Profiles"],
  security: auth,
  request: {
    params: profileName,
    body: {
      required: true,
      content: { "application/json": { schema: z.object({ target: z.enum(["memory", "user"]), content: z.string() }) } },
    },
  },
  responses: { 200: { description: "Added", content: { "application/json": { schema: z.unknown() } } }, 401: err("Unauthorized") },
});

registry.registerPath({
  method: "patch",
  path: "/api/v1/profiles/{name}/memory/entries",
  summary: "Replace a memory entry",
  tags: ["Profiles"],
  security: auth,
  request: {
    params: profileName,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({ target: z.enum(["memory", "user"]), match: z.string(), content: z.string() }),
        },
      },
    },
  },
  responses: { 200: { description: "Replaced", content: { "application/json": { schema: z.unknown() } } }, 401: err("Unauthorized") },
});

registry.registerPath({
  method: "delete",
  path: "/api/v1/profiles/{name}/memory/entries",
  summary: "Delete a memory entry",
  tags: ["Profiles"],
  security: auth,
  request: {
    params: profileName,
    body: { required: true, content: { "application/json": { schema: z.object({ target: z.enum(["memory", "user"]), match: z.string() }) } } },
  },
  responses: { 200: { description: "Deleted", content: { "application/json": { schema: z.unknown() } } }, 401: err("Unauthorized") },
});

registry.registerPath({
  method: "delete",
  path: "/api/v1/profiles/{name}/memory",
  summary: "Reset memory store",
  tags: ["Profiles"],
  security: auth,
  request: {
    params: profileName,
    body: { required: true, content: { "application/json": { schema: z.object({ target: z.enum(["memory", "user", "all"]) }) } } },
  },
  responses: { 200: { description: "Reset", content: { "application/json": { schema: z.unknown() } } }, 401: err("Unauthorized") },
});

registry.registerPath({
  method: "patch",
  path: "/api/v1/profiles/{name}/memory/settings",
  summary: "Update memory provider settings",
  tags: ["Profiles"],
  security: auth,
  request: { params: profileName, body: { content: { "application/json": { schema: z.record(z.unknown()) } } } },
  responses: { 200: { description: "Updated", content: { "application/json": { schema: z.unknown() } } }, 401: err("Unauthorized") },
});

registry.registerPath({
  method: "patch",
  path: "/api/v1/profiles/{name}/memory/provider",
  summary: "Switch memory provider",
  tags: ["Profiles"],
  security: auth,
  request: {
    params: profileName,
    body: { required: true, content: { "application/json": { schema: z.object({ provider: z.string().openapi({ example: "built-in" }) }) } } },
  },
  responses: { 200: { description: "Switched", content: { "application/json": { schema: z.unknown() } } }, 401: err("Unauthorized") },
});

registry.registerPath({
  method: "patch",
  path: "/api/v1/profiles/{name}/memory/providers/{provider}/settings",
  summary: "Update settings for a specific memory provider",
  tags: ["Profiles"],
  security: auth,
  request: {
    params: z.object({ name: z.string(), provider: z.string().openapi({ example: "honcho" }) }),
    body: { content: { "application/json": { schema: z.record(z.unknown()) } } },
  },
  responses: { 200: { description: "Updated", content: { "application/json": { schema: z.unknown() } } }, 400: err("Unsupported provider"), 401: err("Unauthorized") },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/profiles/{name}/permissions",
  summary: "View permissions config",
  tags: ["Profiles"],
  security: auth,
  request: { params: profileName },
  responses: { 200: { description: "Permissions", content: { "application/json": { schema: z.unknown() } } }, 401: err("Unauthorized") },
});

registry.registerPath({
  method: "patch",
  path: "/api/v1/profiles/{name}/permissions",
  summary: "Update permissions config",
  tags: ["Profiles"],
  security: auth,
  request: { params: profileName, body: { required: true, content: { "application/json": { schema: z.record(z.unknown()) } } } },
  responses: { 200: { description: "Updated", content: { "application/json": { schema: z.unknown() } } }, 401: err("Unauthorized") },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/profiles/{name}/tool-configs/{toolKey}",
  summary: "Get tool config",
  description: "`toolKey`: `web` / `image_gen` / `stt` / `tts` / `messaging` / `homeassistant` / `rl`",
  tags: ["Profiles"],
  security: auth,
  request: { params: z.object({ name: z.string(), toolKey: z.string() }) },
  responses: { 200: { description: "Tool config", content: { "application/json": { schema: z.unknown() } } }, 401: err("Unauthorized") },
});

registry.registerPath({
  method: "patch",
  path: "/api/v1/profiles/{name}/tool-configs/{toolKey}",
  summary: "Update tool config",
  tags: ["Profiles"],
  security: auth,
  request: {
    params: z.object({ name: z.string(), toolKey: z.string() }),
    body: { required: true, content: { "application/json": { schema: z.record(z.unknown()) } } },
  },
  responses: { 200: { description: "Updated", content: { "application/json": { schema: z.unknown() } } }, 401: err("Unauthorized") },
});

// ─── Cron Jobs ────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/v1/cron-jobs",
  summary: "List all cron jobs across all profiles",
  tags: ["Cron Jobs"],
  security: auth,
  request: { query: z.object({ include_disabled: z.string().optional() }) },
  responses: {
    200: {
      description: "Cron jobs",
      content: { "application/json": { schema: z.object({ ok: z.boolean(), jobs: z.array(CronJobSchema.extend({ _profile: z.string() })), failures: z.array(z.unknown()) }) } },
    },
    401: err("Unauthorized"),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/profiles/{name}/cron-jobs",
  summary: "List cron jobs for a profile",
  tags: ["Cron Jobs"],
  security: auth,
  request: { params: profileName, query: z.object({ include_disabled: z.string().optional() }) },
  responses: {
    200: { description: "Cron jobs", content: { "application/json": { schema: z.object({ ok: z.literal(true), jobs: z.array(CronJobSchema) }) } } },
    401: err("Unauthorized"),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/profiles/{name}/cron-jobs",
  summary: "Create a cron job",
  tags: ["Cron Jobs"],
  security: auth,
  request: {
    params: profileName,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            name: z.string(),
            schedule: z.string().openapi({ example: "0 9 * * *" }),
            input: z.string().optional(),
            enabled: z.boolean().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: z.object({ ok: z.literal(true), job: CronJobSchema }) } } },
    401: err("Unauthorized"),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/profiles/{name}/cron-jobs/{jobId}",
  summary: "Get cron job details",
  tags: ["Cron Jobs"],
  security: auth,
  request: { params: jobId },
  responses: {
    200: { description: "Cron job", content: { "application/json": { schema: z.object({ ok: z.literal(true), job: CronJobSchema }) } } },
    401: err("Unauthorized"),
    404: err("Not found"),
  },
});

registry.registerPath({
  method: "patch",
  path: "/api/v1/profiles/{name}/cron-jobs/{jobId}",
  summary: "Update a cron job",
  tags: ["Cron Jobs"],
  security: auth,
  request: {
    params: jobId,
    body: { content: { "application/json": { schema: z.object({ name: z.string().optional(), schedule: z.string().optional(), input: z.string().optional(), enabled: z.boolean().optional() }) } } },
  },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: z.object({ ok: z.literal(true), job: CronJobSchema }) } } },
    401: err("Unauthorized"),
  },
});

registry.registerPath({
  method: "delete",
  path: "/api/v1/profiles/{name}/cron-jobs/{jobId}",
  summary: "Delete a cron job",
  tags: ["Cron Jobs"],
  security: auth,
  request: { params: jobId },
  responses: { 200: { description: "Deleted", content: { "application/json": { schema: OkSchema } } }, 401: err("Unauthorized") },
});

for (const action of ["pause", "resume", "run"] as const) {
  registry.registerPath({
    method: "post",
    path: `/api/v1/profiles/{name}/cron-jobs/{jobId}/${action}`,
    summary: `${action.charAt(0).toUpperCase() + action.slice(1)} a cron job`,
    tags: ["Cron Jobs"],
    security: auth,
    request: { params: jobId },
    responses: {
      200: { description: "OK", content: { "application/json": { schema: z.object({ ok: z.literal(true), job: CronJobSchema }) } } },
      401: err("Unauthorized"),
    },
  });
}

// ─── Runs ─────────────────────────────────────────────────────────────────

registry.registerPath({
  method: "post",
  path: "/api/v1/runs",
  summary: "Submit a run to Hermes Agent (returns 202)",
  tags: ["Runs"],
  security: auth,
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            input: z.string().openapi({ example: "Organise my ~/Downloads folder" }),
            profile: z.string().optional().openapi({ example: "default" }),
            instructions: z.string().optional(),
            session_id: z.string().optional(),
            conversation_history: z.array(z.unknown()).optional(),
          }),
        },
      },
    },
  },
  responses: {
    202: {
      description: "Run created",
      content: { "application/json": { schema: z.object({ run_id: z.string(), fallback: z.boolean() }) } },
    },
    400: err("input is required"),
    401: err("Unauthorized"),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/runs/{runId}/events",
  summary: "Subscribe to run event stream (SSE proxy)",
  tags: ["Runs"],
  security: auth,
  request: { params: runId, query: z.object({ profile: z.string().optional() }) },
  responses: { 200: { description: "SSE stream (text/event-stream)" }, 401: err("Unauthorized") },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/runs/{runId}/cancel",
  summary: "Cancel a run",
  tags: ["Runs"],
  security: auth,
  request: {
    params: runId,
    body: { content: { "application/json": { schema: z.object({ profile: z.string().optional() }) } } },
  },
  responses: { 200: { description: "Cancelled", content: { "application/json": { schema: OkSchema } } }, 401: err("Unauthorized") },
});

// ─── Updates ──────────────────────────────────────────────────────────────

for (const [tag, prefix] of [["Updates – Hermes", "/api/v1/hermes"], ["Updates – Link", "/api/v1/link"]] as const) {
  registry.registerPath({
    method: "get", path: `${prefix}/update-check`, summary: "Check for a new version", tags: [tag], security: auth,
    responses: { 200: { description: "Update info", content: { "application/json": { schema: z.unknown() } } }, 401: err("Unauthorized") },
  });
  registry.registerPath({
    method: "get", path: `${prefix}/update/status`, summary: "Query update progress", tags: [tag], security: auth,
    responses: { 200: { description: "Status", content: { "application/json": { schema: z.unknown() } } }, 401: err("Unauthorized") },
  });
  registry.registerPath({
    method: "post", path: `${prefix}/update`, summary: "Trigger update (returns 202)", tags: [tag], security: auth,
    request: { body: { content: { "application/json": { schema: z.object({ version: z.string().optional() }) } } } },
    responses: { 202: { description: "Update started", content: { "application/json": { schema: z.unknown() } } }, 401: err("Unauthorized") },
  });
  registry.registerPath({
    method: "get", path: `${prefix}/update/events`, summary: "Update progress SSE stream", tags: [tag], security: auth,
    responses: { 200: { description: "SSE stream" }, 401: err("Unauthorized") },
  });
}

// ─── System ───────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/v1/system/status",
  summary: "System details (version, autostart, network)",
  tags: ["System"],
  responses: {
    200: {
      description: "System status",
      content: {
        "application/json": {
          schema: z.object({
            version: z.string(),
            linkId: z.string().nullable(),
            port: z.number(),
            autostart: z.object({ supported: z.boolean(), enabled: z.boolean(), method: z.string().nullable() }),
            environment: z.object({ kind: z.string(), warning: z.string().nullable() }),
          }),
        },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/system/version",
  summary: "Link version only",
  tags: ["System"],
  responses: { 200: { description: "Version", content: { "application/json": { schema: z.object({ version: z.string() }) } } } },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/system/autostart/enable",
  summary: "Enable autostart on login",
  tags: ["System"],
  security: auth,
  responses: { 200: { description: "Enabled", content: { "application/json": { schema: z.unknown() } } }, 401: err("Unauthorized") },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/system/autostart/disable",
  summary: "Disable autostart",
  tags: ["System"],
  security: auth,
  responses: { 200: { description: "Disabled", content: { "application/json": { schema: z.unknown() } } }, 401: err("Unauthorized") },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/system/logs",
  summary: "Recent Link logs",
  tags: ["System"],
  security: auth,
  request: { query: z.object({ limit: z.string().optional() }) },
  responses: { 200: { description: "Log entries", content: { "application/json": { schema: z.object({ entries: z.array(z.unknown()) }) } } }, 401: err("Unauthorized") },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/system/logs/gateway",
  summary: "Recent gateway logs",
  tags: ["System"],
  security: auth,
  request: { query: z.object({ limit: z.string().optional() }) },
  responses: { 200: { description: "Log entries", content: { "application/json": { schema: z.object({ entries: z.array(z.unknown()) }) } } }, 401: err("Unauthorized") },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/system/updates",
  summary: "Available updates (Hermes + Link combined)",
  tags: ["System"],
  security: auth,
  responses: { 200: { description: "Update info", content: { "application/json": { schema: z.unknown() } } }, 401: err("Unauthorized") },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/system/updates/dismiss",
  summary: "Dismiss current update notification",
  tags: ["System"],
  security: auth,
  responses: { 200: { description: "Dismissed", content: { "application/json": { schema: OkSchema } } }, 401: err("Unauthorized") },
});

// ─── Internal ─────────────────────────────────────────────────────────────

registry.registerPath({
  method: "post",
  path: "/internal/deliver",
  summary: "Deliver staged files to a conversation (loopback only)",
  description: "Only accepts requests from 127.0.0.1 / ::1. Used by Hermes Agent to hand off media blobs.",
  tags: ["System"],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: z.object({ staging_dir: z.string() }) } },
    },
  },
  responses: {
    200: { description: "Delivered", content: { "application/json": { schema: z.object({ ok: z.literal(true), staged_count: z.number() }) } } },
    400: err("staging_dir missing"),
    403: err("Non-loopback request"),
  },
});

// ─── Spec generator ───────────────────────────────────────────────────────

let cachedSpec: object | null = null;

export function generateSpec(version: string): object {
  if (!cachedSpec) {
    const generator = new OpenApiGeneratorV3(registry.definitions);
    cachedSpec = generator.generateDocument({
      openapi: "3.0.0",
      info: {
        title: "Hermes Link API",
        version,
        description: "Local HTTP API exposed by the Hermes Link daemon.",
      },
      servers: [{ url: `http://localhost:${LINK_DEFAULT_PORT}`, description: "Local daemon (default port)" }],
    });
  }
  return cachedSpec;
}

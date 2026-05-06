import type { Context } from "koa";
import { EventEmitter } from "events";

export interface SseEmitter {
  send(event: string, data: unknown): void;
  close(): void;
}

export function createSseResponse(ctx: Context): SseEmitter {
  ctx.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  ctx.status = 200;

  const emitter = new EventEmitter();
  // Koa passes control to the SSE stream by keeping the response body writable
  ctx.res.flushHeaders?.();

  const send = (event: string, data: unknown): void => {
    const payload = typeof data === "string" ? data : JSON.stringify(data);
    const chunk = `event: ${event}\ndata: ${payload}\n\n`;
    if (!ctx.res.writableEnded) {
      ctx.res.write(chunk);
    }
  };

  const close = (): void => {
    if (!ctx.res.writableEnded) {
      ctx.res.end();
    }
  };

  ctx.req.once("close", () => {
    emitter.emit("close");
  });

  ctx.body = ctx.res;

  return { send, close };
}

export function formatSseData(data: unknown): string {
  return typeof data === "string" ? data : JSON.stringify(data);
}

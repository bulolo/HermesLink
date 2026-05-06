import type { IncomingMessage, ServerResponse } from "http";

export function beginSseStream(
  req: IncomingMessage,
  res: ServerResponse,
  options: { onClose?: () => void } = {},
): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(": heartbeat\n\n");
  }, 25000);
  heartbeat.unref?.();
  const cleanup = () => {
    clearInterval(heartbeat);
    options.onClose?.();
  };
  req.once("close", cleanup);
  req.once("aborted", cleanup);
}

export function writeSseEvent(res: ServerResponse, data: unknown): void {
  if (res.writableEnded) return;
  const json = typeof data === "string" ? data : JSON.stringify(data);
  const d = data as Record<string, unknown>;
  if (d && typeof d.seq === "number") {
    res.write(`id: ${d.seq}\n`);
  }
  if (d && typeof d.type === "string") {
    res.write(`event: ${d.type}\n`);
  }
  res.write(`data: ${json}\n\n`);
}

export function writeJsonSseEvent(res: ServerResponse, data: { event: string; data: unknown }): void {
  if (res.writableEnded) return;
  res.write(`event: ${data.event}\ndata: ${JSON.stringify(data.data)}\n\n`);
}

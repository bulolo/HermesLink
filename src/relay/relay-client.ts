import { EventEmitter } from "events";
import { createFileLogger, type LinkLogger } from "../runtime/logger.js";
import { type RuntimePaths } from "../runtime/paths.js";
import { refreshRelayToken } from "./bootstrap.js";
import { type LinkIdentity } from "../identity/identity.js";

// Node.js 18+ ships undici WebSocket; fallback to ws package
let WS: typeof WebSocket;
try {
  WS = WebSocket;
} catch {
  // Will be imported dynamically below if needed
}

export type RelayClientState = "disconnected" | "connecting" | "connected" | "closing";

export interface RelayClientOptions {
  relayBaseUrl: string;
  identity: LinkIdentity;
  token: string;
  paths?: RuntimePaths;
  fetchImpl?: typeof fetch;
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  pingIntervalMs?: number;
}

export interface RelayMessage {
  type: string;
  [key: string]: unknown;
}

export class RelayClient extends EventEmitter {
  private options: RelayClientOptions;
  private ws: WebSocket | null = null;
  private state: RelayClientState = "disconnected";
  private token: string;
  private logger: LinkLogger;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectDelay: number;
  private closed = false;

  constructor(options: RelayClientOptions) {
    super();
    this.options = options;
    this.token = options.token;
    this.reconnectDelay = options.reconnectDelayMs ?? 1000;
    this.logger = createFileLogger({ paths: options.paths });
  }

  get currentState(): RelayClientState {
    return this.state;
  }

  start(): void {
    if (this.closed) return;
    this.connect();
  }

  stop(): void {
    this.closed = true;
    this.clearTimers();
    if (this.ws) {
      this.state = "closing";
      try {
        this.ws.close(1000, "client shutdown");
      } catch {
        // ignore
      }
    }
  }

  send(message: RelayMessage): void {
    if (this.state !== "connected" || !this.ws) return;
    try {
      this.ws.send(JSON.stringify(message));
    } catch (err) {
      this.logger.warn("Failed to send relay message", { error: String(err) }).catch(() => undefined);
    }
  }

  private connect(): void {
    if (this.closed) return;
    this.state = "connecting";
    const wsUrl = this.buildWsUrl();
    try {
      const ws = new WS(wsUrl, {
        headers: { authorization: `Bearer ${this.token}` },
      } as WebSocketInit);
      this.ws = ws;

      ws.addEventListener("open", () => {
        this.reconnectDelay = this.options.reconnectDelayMs ?? 1000;
        this.state = "connected";
        this.startPing();
        this.emit("connected");
        this.logger.info("Relay WebSocket connected").catch(() => undefined);
      });

      ws.addEventListener("message", (event: MessageEvent) => {
        try {
          const message = JSON.parse(event.data as string) as RelayMessage;
          this.emit("message", message);
        } catch {
          // ignore non-JSON messages
        }
      });

      ws.addEventListener("close", (event: { code: number; reason: string }) => {
        this.stopPing();
        this.ws = null;
        this.state = "disconnected";
        this.emit("disconnected", { code: event.code, reason: event.reason });
        if (!this.closed) {
          this.scheduleReconnect();
        }
      });

      ws.addEventListener("error", (event: Event) => {
        this.logger.warn("Relay WebSocket error", { error: String(event) }).catch(() => undefined);
      });
    } catch (err) {
      this.state = "disconnected";
      this.logger.warn("Failed to create WebSocket", { error: String(err) }).catch(() => undefined);
      if (!this.closed) {
        this.scheduleReconnect();
      }
    }
  }

  private buildWsUrl(): string {
    const base = this.options.relayBaseUrl
      .replace(/\/+$/u, "")
      .replace(/^http/u, "ws");
    return `${base}/api/v1/relay/links/${this.options.identity.link_id}/ws`;
  }

  private scheduleReconnect(): void {
    const maxDelay = this.options.maxReconnectDelayMs ?? 30_000;
    const delay = Math.min(this.reconnectDelay, maxDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, maxDelay);
    this.reconnectTimer = setTimeout(() => {
      if (this.closed) return;
      this.maybeRefreshTokenAndReconnect().catch(() => undefined);
    }, delay);
  }

  private async maybeRefreshTokenAndReconnect(): Promise<void> {
    try {
      this.token = await refreshRelayToken({
        relayBaseUrl: this.options.relayBaseUrl,
        identity: this.options.identity,
        fetchImpl: this.options.fetchImpl,
      });
    } catch {
      // use existing token
    }
    this.connect();
  }

  private startPing(): void {
    const intervalMs = this.options.pingIntervalMs ?? 25_000;
    this.pingTimer = setInterval(() => {
      if (this.state === "connected" && this.ws) {
        try {
          this.ws.send(JSON.stringify({ type: "ping" }));
        } catch {
          // ignore
        }
      }
    }, intervalMs);
  }

  private stopPing(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private clearTimers(): void {
    this.stopPing();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

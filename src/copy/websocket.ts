/**
 * WebSocket connection manager for Copy's real-time channel feed.
 * Handles reconnection with exponential backoff and proactive token refresh.
 */

import WebSocket from "ws";
import { getWsToken, buildWsUrl } from "./api.js";
import type { CopyWsEvent } from "../types.js";

export type MessageHandler = (msg: CopyWsEvent) => Promise<void> | void;
export type TokenRefresher = () => Promise<void>;

export class ChannelSocket {
  private ws: WebSocket | null = null;
  private channelId: string;
  private apiUrl: string;
  private handler: MessageHandler;
  private tokenRefresher: TokenRefresher | null;
  private reconnectDelay = 1000;
  private maxDelay = 30000;
  private stopping = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private log: (msg: string) => void;

  constructor(
    apiUrl: string,
    channelId: string,
    handler: MessageHandler,
    tokenRefresher?: TokenRefresher,
    log?: (msg: string) => void,
  ) {
    this.apiUrl = apiUrl;
    this.channelId = channelId;
    this.handler = handler;
    this.tokenRefresher = tokenRefresher ?? null;
    this.log = log ?? ((msg) => {});
  }

  async start(): Promise<void> {
    this.stopping = false;
    await this.connect();
  }

  stop(): void {
    this.stopping = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.ws) {
      this.ws.terminate();
      this.ws = null;
    }
  }

  private async connect(): Promise<void> {
    try {
      if (this.tokenRefresher) {
        await this.tokenRefresher();
      }

      const tokenRes = await getWsToken(this.apiUrl);
      if (!tokenRes.ok || !tokenRes.data?.token) {
        throw new Error(`Failed to get WS token: ${tokenRes.error ?? "unknown"}`);
      }

      const url = buildWsUrl(this.apiUrl, this.channelId, tokenRes.data.token);
      const tag = this.channelId.slice(0, 8);
      this.log(`[WS:${tag}] Connecting...`);

      this.ws = new WebSocket(url);

      this.ws.on("open", () => {
        this.log(`[WS:${tag}] Connected`);
        this.reconnectDelay = 1000;

        this.pingInterval = setInterval(() => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.ping();
          }
        }, 25000);
      });

      this.ws.on("message", async (data) => {
        try {
          const msg = JSON.parse(data.toString()) as CopyWsEvent;
          await this.handler(msg);
        } catch (err) {
          this.log(`[WS:${tag}] Message parse error: ${err}`);
        }
      });

      this.ws.on("close", (code, reason) => {
        this.log(`[WS:${tag}] Disconnected (${code}: ${reason})`);
        if (this.pingInterval) {
          clearInterval(this.pingInterval);
          this.pingInterval = null;
        }
        this.scheduleReconnect();
      });

      this.ws.on("error", (err) => {
        this.log(`[WS:${tag}] Error: ${err.message}`);
      });
    } catch (err) {
      this.log(`[WS:${this.channelId.slice(0, 8)}] Connection failed: ${err}`);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopping) return;

    this.log(`[WS:${this.channelId.slice(0, 8)}] Reconnecting in ${this.reconnectDelay}ms...`);
    this.reconnectTimer = setTimeout(async () => {
      await this.connect();
    }, this.reconnectDelay);

    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxDelay);
  }
}

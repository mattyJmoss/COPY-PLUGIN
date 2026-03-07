/**
 * Shared mutable state for the Copy gateway runtime.
 *
 * The startAccount closure populates this on startup.
 * Agent tools read/write it to hot-add channels at runtime.
 */

import type { ChannelInfo, Keypair } from "./types.js";
import type { ChannelSocket } from "./copy/websocket.js";
import type { InboundContext } from "./copy/inbound.js";

export interface CopyGatewayState {
  apiUrl: string;
  dataDir: string;
  keypair: Keypair;
  cachedUserId: string;
  cachedChannels: ChannelInfo[];
  channelSecrets: Map<string, Uint8Array>;
  sockets: ChannelSocket[];
  inboundCtx: InboundContext;
  tokenRefresher: () => Promise<void>;
  dispatchWsEvent: (event: any, channelId: string) => void;
  log: (msg: string) => void;
}

let _state: CopyGatewayState | null = null;

export function setCopyGatewayState(state: CopyGatewayState): void {
  _state = state;
}

export function getCopyGatewayState(): CopyGatewayState | null {
  return _state;
}

export function clearCopyGatewayState(): void {
  _state = null;
}

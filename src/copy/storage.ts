/**
 * File-based storage for keypair, session, and channel data.
 * Keypair file gets chmod 600 for security.
 */

import fs from "fs/promises";
import path from "path";
import type { Keypair, Session, ChannelInfo } from "../types.js";

export interface ChannelsData {
  channels: ChannelInfo[];
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

function keypairPath(dataDir: string): string {
  return path.join(dataDir, "keypair.json");
}

function sessionPath(dataDir: string): string {
  return path.join(dataDir, "session.json");
}

function channelsPath(dataDir: string): string {
  return path.join(dataDir, "channels.json");
}

// ── Keypair ──

export async function saveKeypair(dataDir: string, keypair: Keypair): Promise<void> {
  await ensureDir(dataDir);
  const p = keypairPath(dataDir);
  await fs.writeFile(p, JSON.stringify(keypair, null, 2), { mode: 0o600 });
  await fs.chmod(p, 0o600);
}

export async function loadKeypair(dataDir: string): Promise<Keypair | null> {
  try {
    const raw = await fs.readFile(keypairPath(dataDir), "utf-8");
    return JSON.parse(raw) as Keypair;
  } catch {
    return null;
  }
}

// ── Session ──

export async function saveSession(dataDir: string, session: Session): Promise<void> {
  await ensureDir(dataDir);
  const p = sessionPath(dataDir);
  await fs.writeFile(p, JSON.stringify(session, null, 2), { mode: 0o600 });
  await fs.chmod(p, 0o600);
}

export async function loadSession(dataDir: string): Promise<Session | null> {
  try {
    const raw = await fs.readFile(sessionPath(dataDir), "utf-8");
    const session = JSON.parse(raw) as Session;

    // Check if token is expired (with 60s buffer)
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (session.expiresAt < nowSeconds + 60) {
      return null;
    }

    return session;
  } catch {
    return null;
  }
}

/** Read userId directly from session file without expiry check. */
export async function readUserId(dataDir: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(sessionPath(dataDir), "utf-8");
    const session = JSON.parse(raw) as Session;
    return session.userId ?? null;
  } catch {
    return null;
  }
}

// ── Channels ──

export async function loadChannels(dataDir: string): Promise<ChannelsData> {
  try {
    const raw = await fs.readFile(channelsPath(dataDir), "utf-8");
    return JSON.parse(raw) as ChannelsData;
  } catch {
    return { channels: [] };
  }
}

export async function saveChannels(dataDir: string, data: ChannelsData): Promise<void> {
  await ensureDir(dataDir);
  await fs.writeFile(channelsPath(dataDir), JSON.stringify(data, null, 2), "utf-8");
}

export async function addChannel(dataDir: string, channel: ChannelInfo): Promise<void> {
  const data = await loadChannels(dataDir);
  data.channels = data.channels.filter((c) => c.channelId !== channel.channelId);
  data.channels.push(channel);
  await saveChannels(dataDir, data);
}

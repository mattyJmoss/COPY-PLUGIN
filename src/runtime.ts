import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setCopyRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getCopyRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Copy runtime not initialized");
  }
  return runtime;
}

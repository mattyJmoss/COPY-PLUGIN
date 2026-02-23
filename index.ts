/**
 * Copy channel plugin entry point.
 *
 * Registers the Copy channel with OpenClaw so agents can
 * receive and respond to voice messages via the Copy app.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { setCopyRuntime } from "./src/runtime.js";
import { copyPlugin } from "./src/channel.js";

export default function register(api: OpenClawPluginApi) {
  setCopyRuntime(api.runtime);
  api.registerChannel(copyPlugin);
}

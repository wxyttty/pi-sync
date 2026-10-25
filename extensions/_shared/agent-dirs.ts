/**
 * Shared agent-directory resolution for Pi extensions.
 *
 * Mirrors Pi core's config.getAgentDir():
 *   - PI_CODING_AGENT_DIR env override (leading `~` expanded)
 *   - default: ~/.pi/agent
 *
 * Import: import { getAgentDir } from "../_shared/agent-dirs"
 */

import * as os from "node:os";
import * as path from "node:path";

/** Expand a leading `~` or `~/` against the real home directory. */
function expandTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || (process.platform === "win32" && p.startsWith("~\\"))) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/** Pi agent config directory: PI_CODING_AGENT_DIR or ~/.pi/agent. */
export function getAgentDir(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  if (envDir && envDir.trim()) return expandTilde(envDir.trim());
  return path.join(os.homedir(), ".pi", "agent");
}

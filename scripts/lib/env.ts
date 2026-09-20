import * as fs from "node:fs";
import { ENV_LOCAL_PATH } from "./paths.js";

// Load .env.local into process.env without overriding variables that are
// already set (for example by the shell or a CI runner).
export function loadLocalEnv(path = ENV_LOCAL_PATH): void {
  if (!fs.existsSync(path)) return;
  const content = fs.readFileSync(path, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [rawKey, ...rawValueParts] = trimmed.split("=");
    const key = rawKey.trim();
    const rawValue = rawValueParts.join("=").trim();
    if (!key || process.env[key] !== undefined) continue;
    process.env[key] = rawValue.replace(/\s+#.*$/, "").replace(/^['"]|['"]$/g, "").trim();
  }
}

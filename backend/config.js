import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_INTERVAL_SEC = 120;

export function readConfig(projectRoot = process.cwd()) {
  const configPath = path.join(projectRoot, "config.json");

  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const refreshInterval = Number(config.refresh_interval_sec);

    return {
      refresh_interval_sec: clampInterval(refreshInterval),
      claude_accounts: parseClaudeAccounts(config.claude_accounts)
    };
  } catch {
    return {
      refresh_interval_sec: DEFAULT_INTERVAL_SEC,
      claude_accounts: []
    };
  }
}

function parseClaudeAccounts(accounts) {
  if (!Array.isArray(accounts)) {
    return [];
  }

  return accounts
    .filter((a) => a && typeof a.label === "string" && a.label.trim() && typeof a.config_dir === "string")
    .map((a) => ({ label: a.label.trim(), config_dir: expandTilde(a.config_dir) }));
}

function expandTilde(dir) {
  if (dir === "~" || dir.startsWith("~/")) {
    return path.join(os.homedir(), dir.slice(1));
  }

  return dir;
}

function clampInterval(value) {
  if (!Number.isFinite(value)) {
    return DEFAULT_INTERVAL_SEC;
  }

  return Math.min(120, Math.max(30, value));
}

import pty from "node-pty";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getProviderPtyLaunch, augmentPath } from "./platform.js";
import { parseClaudeUsage } from "./parser.js";
import { preparePtyRuntime } from "./ptySupport.js";
import { closePtyChild } from "./ptyCleanup.js";

const ANSI_PATTERN = /\x1b\[[0-9;?]*[A-Za-z]/g;
const CONPTY_NOISE_PATTERN = /C:\\.*node-pty\\lib\\conpty_console_list_agent\.js[\s\S]*$/i;

export function runClaudeUsagePty(options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000;

  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    let usageAttempted = false;
    let usageCommandCount = 0;
    let dismissedDialogHandled = false;
    let trustPromptAccepted = false;
    let trustConfirmed = false;
    let trustNudgeAttempts = 0;
    let trustSettleTimer = null;
    let themePickerHandled = false;
    const eventLog = [];
    let child;

    try {
      const env = augmentPath({ ...process.env });
      if (options.configDir && !isDefaultClaudeConfigDir(options.configDir)) {
        env.CLAUDE_CONFIG_DIR = options.configDir;
      }
      const launch = getProviderPtyLaunch("claude", "claude", env);
      preparePtyRuntime();
      child = pty.spawn(launch.file, launch.args, {
        cols: 120,
        rows: 34,
        cwd: options.cwd ?? process.cwd(),
        env
      });
      eventLog.push(`${timestamp()} SPAWN claude`);
    } catch (error) {
      const failureReason = error instanceof Error ? error.message : String(error);
      resolve({
        ok: false,
        stdout: "",
        stderr: failureReason,
        code: null,
        debugLogPath: writeDebugLog({
          ok: false,
          rawOutput: output,
          cleanedOutput: "",
          failureReason,
          eventLog
        })
      });
      return;
    }

    const finish = async (ok) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      clearTimeout(trustSettleTimer);
      usageRetryTimers.forEach(clearTimeout);

      await closePtyChild(child, eventLog, {
        exitInput: "\u001b\r",
        killDelayMs: 250,
        timestamp
      });

      const cleanedOutput = cleanTerminalOutput(output);
      const failureReason = ok ? "" : buildFailureReason(output, usageAttempted);

      resolve({
        ok,
        stdout: cleanedOutput,
        stderr: failureReason,
        code: ok ? 0 : null,
        debugLogPath: writeDebugLog({
          ok,
          rawOutput: output,
          cleanedOutput,
          failureReason,
          eventLog,
          logSuffix: options.logSuffix
        })
      });
    };

    const timer = setTimeout(() => finish(false), timeoutMs);
    const usageRetryTimers = [2_500, 5_000, 8_500, 13_000].map((delay) => setTimeout(() => {
      if (settled || hasClaudeUsage(output)) {
        return;
      }

      const sent = trySendUsageCommand(child, output, usageCommandCount, eventLog);
      usageAttempted = sent || usageAttempted;
      if (sent) {
        usageCommandCount += 1;
      }
    }, delay));

    const scheduleTrustCheck = () => {
      clearTimeout(trustSettleTimer);
      trustSettleTimer = setTimeout(() => {
        if (settled || trustConfirmed) {
          return;
        }

        const selection = currentTrustSelection(cleanTerminalOutput(output));
        if (selection === "yes") {
          trustConfirmed = true;
          eventLog.push(`${timestamp()} EVENT confirm-trust-yes`);
          try {
            child.write("\r");
          } catch {
            // Let the normal timeout path report the failure.
          }
          return;
        }

        trustNudgeAttempts += 1;
        if (trustNudgeAttempts > 5) {
          // Give up nudging and accept whatever is currently selected rather
          // than looping forever.
          trustConfirmed = true;
          eventLog.push(`${timestamp()} EVENT trust-selection-giveup`);
          try {
            child.write("\r");
          } catch {
            // Let the normal timeout path report the failure.
          }
          return;
        }

        eventLog.push(`${timestamp()} EVENT nudge-trust-selection`);
        try {
          child.write("\x1b[B");
        } catch {
          // Let the normal timeout path report the failure.
        }
        scheduleTrustCheck();
      }, 150);
    };

    child.onData((chunk) => {
      eventLog.push(`${timestamp()} DATA ${truncate(chunk.replace(/\r/g, "\\r").replace(/\n/g, "\\n"), 220)}`);
      output += chunk;

      if (!trustPromptAccepted && isTrustPrompt(output)) {
        trustPromptAccepted = true;
        eventLog.push(`${timestamp()} EVENT accept-trust-prompt`);
        scheduleTrustCheck();
        return;
      }

      if (trustPromptAccepted && !trustConfirmed) {
        scheduleTrustCheck();
        return;
      }

      if (!themePickerHandled && isThemePickerScreen(output)) {
        themePickerHandled = true;
        eventLog.push(`${timestamp()} EVENT dismiss-theme-picker`);
        try {
          child.write("\r");
        } catch {
          // Let the normal timeout path report the failure.
        }
      }

      if (isReadyForUsageCommand(output) && !hasClaudeUsage(output) && usageCommandCount === 0) {
        const sent = trySendUsageCommand(child, output, usageCommandCount, eventLog);
        usageAttempted = sent || usageAttempted;
        if (sent) {
          usageCommandCount += 1;
        }
      }

      if (!dismissedDialogHandled && /status dialog dismissed/i.test(output) && usageCommandCount < 2) {
        dismissedDialogHandled = true;
        eventLog.push(`${timestamp()} EVENT status-dialog-dismissed`);
        setTimeout(() => {
          if (settled || hasClaudeUsage(output)) {
            return;
          }

          const sent = trySendUsageCommand(child, output, usageCommandCount, eventLog);
          usageAttempted = sent || usageAttempted;
          if (sent) {
            usageCommandCount += 1;
          }
        }, 250);
      }

      if (hasClaudeUsage(output)) {
        eventLog.push(`${timestamp()} EVENT usage-detected`);
        finish(true);
      }
    });

    child.onExit(() => {
      eventLog.push(`${timestamp()} EXIT`);
      finish(hasClaudeUsage(output));
    });
  });
}

function isDefaultClaudeConfigDir(dir) {
  try {
    return path.resolve(dir) === path.join(os.homedir(), ".claude");
  } catch {
    return false;
  }
}

function isReadyForUsageCommand(output) {
  const cleaned = cleanTerminalOutput(output);
  if (isTrustPrompt(output) || isThemePickerScreen(output)) {
    return false;
  }

  return /Status\s*Config\s*Usage\s*Stats/i.test(cleaned)
    || (/Claude\s*Code/i.test(cleaned) && /\?\s*for\s*shortcuts/i.test(cleaned))
    || /❯\s*(?:Try|$)/i.test(cleaned)
    || />\s*(?:Try|$)/i.test(cleaned);
}

function isThemePickerScreen(output) {
  const cleaned = cleanTerminalOutput(output);
  return /choose\s*the\s*text\s*style/i.test(cleaned);
}

function isTrustPrompt(output) {
  const cleaned = cleanTerminalOutput(output);
  if (isThemePickerScreen(output)) {
    return false;
  }

  return /do\s*you\s*trust\s*the\s*files\s*in\s*this\s*folder/i.test(cleaned)
    || /is\s*this\s*a\s*project\s*you\s*created\s*or\s*one\s*you\s*trust/i.test(cleaned)
    || /enter\s*to\s*confirm/i.test(cleaned);
}

function currentTrustSelection(cleaned) {
  const matches = [...cleaned.matchAll(/❯\s*(No|Yes)\b/gi)];
  if (matches.length === 0) {
    return null;
  }

  return matches[matches.length - 1][1].toLowerCase();
}

function hasClaudeUsage(output) {
  const cleaned = cleanTerminalOutput(output);
  return parseClaudeUsage(cleaned) !== null;
}

function cleanTerminalOutput(value) {
  return value
    .replace(ANSI_PATTERN, "")
    .replace(/\r/g, "\n")
    .replace(CONPTY_NOISE_PATTERN, "")
    .replace(/[\u2502\u2500]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function trySendUsageCommand(child, output, usageCommandCount, eventLog) {
  if (usageCommandCount >= 3 || !isReadyForUsageCommand(output)) {
    return false;
  }

  try {
    eventLog.push(`${timestamp()} WRITE <ENTER>`);
    child.write("\r");
  } catch {
    // Ignore prompt wake-up failures.
  }

  setTimeout(() => {
    try {
      eventLog.push(`${timestamp()} WRITE /usage`);
      child.write("/usage\r");
    } catch {
      // Ignore write failures here and let the normal timeout path handle it.
    }
  }, 150);

  return true;
}

function buildFailureReason(output, usageAttempted) {
  const cleaned = cleanTerminalOutput(output);
  if (!usageAttempted) {
    return cleaned ? `Prompt not ready: ${cleaned.slice(0, 140)}` : "Prompt not ready";
  }

  if (!cleaned) {
    return "No output captured";
  }

  return `Unexpected output: ${cleaned.slice(0, 160)}`;
}

function writeDebugLog({ ok, rawOutput, cleanedOutput, failureReason, eventLog, logSuffix }) {
  const logDir = path.join(os.tmpdir(), "ai-usage-widget");
  mkdirSync(logDir, { recursive: true });

  const fileName = logSuffix ? `claude-${logSuffix}-debug.log` : "claude-debug.log";
  const logPath = path.join(logDir, fileName);
  const body = [
    `timestamp=${new Date().toISOString()}`,
    `ok=${ok}`,
    `failure_reason=${failureReason || ""}`,
    "",
    "[events]",
    ...eventLog,
    "",
    "[cleaned_output]",
    cleanedOutput,
    "",
    "[raw_output]",
    rawOutput
  ].join("\n");

  writeFileSync(logPath, body, "utf8");
  return logPath;
}

function truncate(value, maxLength) {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

function timestamp() {
  return new Date().toISOString();
}

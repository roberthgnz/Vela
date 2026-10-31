import { invoke, isTauri } from "@tauri-apps/api/core";

/**
 * Vela's log. Lines go to the console and, in the desktop app, to `logs/vela.log` in the app data
 * folder (`logging.rs`), where «Copiar diagnóstico» in Settings reads them back. Nothing leaves the
 * device. Do not log addon URLs, stream URLs or session keys: they can carry tokens.
 */
export type LogLevel = "info" | "warn" | "error";

/** At most this many lines reach the file per minute; a render loop would otherwise fill it. */
const LIMIT_PER_MINUTE = 120;
let windowStart = 0;
let sent = 0;
let dropped = 0;

function describe(detail: unknown): string {
  if (detail === undefined) return "";
  if (detail instanceof Error) return ` — ${detail.name}: ${detail.message}${detail.stack ? `\n${trimStack(detail.stack)}` : ""}`;
  if (typeof detail === "string") return ` — ${detail}`;
  try {
    return ` — ${JSON.stringify(detail)}`;
  } catch {
    return ` — ${String(detail)}`;
  }
}

/** The first lines of a stack, without the message that is already in the entry. */
function trimStack(stack: string): string {
  return stack
    .split("\n")
    .filter((line) => /^\s+at\s/.test(line))
    .slice(0, 6)
    .join("\n");
}

function send(level: LogLevel, line: string) {
  if (!isTauri()) return;
  const now = Date.now();
  if (now - windowStart > 60_000) {
    if (dropped) void invoke("log_write", { level: "warn", message: `${dropped} log lines dropped (rate limit)` }).catch(() => {});
    windowStart = now;
    sent = 0;
    dropped = 0;
  }
  if (sent >= LIMIT_PER_MINUTE) {
    dropped++;
    return;
  }
  sent++;
  void invoke("log_write", { level, message: line }).catch(() => {});
}

function write(level: LogLevel, message: string, detail?: unknown) {
  const line = `${message}${describe(detail)}`;
  const print = level === "error" ? console.error : level === "warn" ? console.warn : console.info;
  print(`[vela] ${line}`);
  send(level, line);
}

export const log = {
  info: (message: string, detail?: unknown) => write("info", message, detail),
  warn: (message: string, detail?: unknown) => write("warn", message, detail),
  error: (message: string, detail?: unknown) => write("error", message, detail),
};

/** Reports errors nobody caught: thrown in handlers, rejected promises without a catch. */
export function installGlobalErrorLogging(): void {
  if (typeof window === "undefined") return;
  window.addEventListener("error", (event) => {
    // Resource errors (a poster that fails to load) arrive here too, without a message.
    if (!event.message && event.target !== window) return;
    log.error(`uncaught: ${event.message}`, event.error ?? `${event.filename}:${event.lineno}`);
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason: unknown = event.reason;
    if (reason instanceof DOMException && reason.name === "AbortError") return;
    log.error("unhandled rejection", reason);
  });
}

/** The end of the log file (desktop only). */
export async function logTail(): Promise<string> {
  if (!isTauri()) return "";
  return invoke<string>("log_tail");
}

export async function logFolder(): Promise<string> {
  if (!isTauri()) return "";
  return invoke<string>("log_folder");
}

export function revealLog(): Promise<void> {
  return invoke("log_reveal");
}

/** Saves the report in the logs folder and shows it in Explorer; returns its path. */
export function saveReport(report: string): Promise<string> {
  return invoke<string>("log_save_report", { report });
}

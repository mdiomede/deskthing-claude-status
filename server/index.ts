// Server half of the Claude Status app. Runs in Node inside DeskThing on the PC.
//
// Data source: ~/.claude/claude-sessions.json, written by the Claude Code hook
// at ~/.claude/hooks/claude-status.ps1. That hook fires on UserPromptSubmit,
// Stop, SessionStart, SessionEnd and Notification, so the file always reflects
// what every live session is doing.
//
// We poll rather than fs.watch: the hook writes via write-temp + rename, so a
// watcher would fire on a path that has just been replaced.

import { createDeskThing } from "@deskthing/server";
import { AppSettings, DESKTHING_EVENTS, SETTING_TYPES } from "@deskthing/types";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CLIENT_TYPE,
  SERVER_TYPE,
  ClaudeSession,
  SessionState,
  StatusPayload,
  ToClientData,
  ToServerData,
} from "../shared/transit";

const DeskThing = createDeskThing<ToServerData, ToClientData>();

const STATE_FILE = join(homedir(), ".claude", "claude-sessions.json");

const SETTING_IDS = {
  INTERVAL: "refresh_interval",
  SHOW_DONE: "show_done",
} as const;

const DEFAULTS = { interval: 1, showDone: true };

/* ---------------------------------------------------------------------------
 * Settings are CACHED, never fetched from the poll path.
 *
 * v0.1.0 called DeskThing.getSettings() on every tick and re-armed the interval
 * from inside the SETTINGS handler. Reading settings re-entered that handler,
 * which armed another interval, which read settings again. Intervals stacked
 * until the process ran out of file descriptors and every read failed EMFILE.
 * Settings now change in exactly one place: the SETTINGS event.
 * ------------------------------------------------------------------------- */
let cfg = { ...DEFAULTS };
let cancelPoll: (() => void) | null = null;
let armedIntervalMs = 0;
let lastSerialized = "";
let reading = false;

const VALID_STATES: SessionState[] = ["blocked", "working", "idle", "done"];

const readSessions = async (): Promise<StatusPayload> => {
  const now = new Date().toISOString();
  let raw: string;

  try {
    raw = await readFile(STATE_FILE, "utf-8");
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return { sessions: [], updated: now };
    return {
      sessions: [],
      updated: now,
      error: `Cannot read state file (${code ?? "unknown"})`,
    };
  }

  if (!raw.trim()) return { sessions: [], updated: now };

  let parsed: { sessions?: Record<string, Partial<ClaudeSession>> };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { sessions: [], updated: now, error: "State file is not valid JSON" };
  }

  const sessions: ClaudeSession[] = Object.entries(parsed.sessions ?? {})
    .map(([id, v]) => ({
      id,
      project: v.project || "Claude Code",
      cwd: v.cwd || "",
      state: (VALID_STATES.includes(v.state as SessionState)
        ? v.state
        : "idle") as SessionState,
      updated: v.updated || now,
      message: v.message || undefined,
    }))
    .sort((a, b) => {
      if (a.state === "blocked" && b.state !== "blocked") return -1;
      if (b.state === "blocked" && a.state !== "blocked") return 1;
      return (b.updated || "").localeCompare(a.updated || "");
    });

  return { sessions, updated: now };
};

const pushStatus = async (clientId?: string, force = false) => {
  // A slow disk must never let ticks pile up on top of each other.
  if (reading) return;
  reading = true;
  try {
    const payload = await readSessions();

    if (!cfg.showDone) {
      payload.sessions = payload.sessions.filter((s) => s.state !== "done");
    }

    const serialized = JSON.stringify(payload.sessions) + (payload.error ?? "");
    if (!clientId && !force && serialized === lastSerialized) return;
    if (!clientId) lastSerialized = serialized;

    DeskThing.send({
      clientId,
      type: SERVER_TYPE.STATUS,
      request: "update",
      payload,
    });
  } finally {
    reading = false;
  }
};

const armPolling = (ms: number) => {
  if (cancelPoll && armedIntervalMs === ms) return; // already correct
  if (typeof cancelPoll === "function") {
    try {
      cancelPoll();
    } catch {
      /* ignore */
    }
  }
  cancelPoll = null;
  armedIntervalMs = ms;

  const handle = DeskThing.setInterval(() => {
    void pushStatus();
  }, ms);

  // Defensive: if the framework ever stops returning a canceller, we must not
  // silently lose the ability to stop the old timer and start stacking again.
  cancelPoll = typeof handle === "function" ? handle : null;
  if (!cancelPoll) {
    console.warn("[claude-status] setInterval returned no canceller");
  }
  console.log(`[claude-status] polling every ${ms}ms`);
};

const applySettings = (settings: AppSettings | undefined) => {
  if (!settings) return;

  const i = settings[SETTING_IDS.INTERVAL];
  if (i && i.type === SETTING_TYPES.NUMBER && typeof i.value === "number") {
    cfg.interval = i.value;
  }
  const d = settings[SETTING_IDS.SHOW_DONE];
  if (d && d.type === SETTING_TYPES.BOOLEAN && typeof d.value === "boolean") {
    cfg.showDone = d.value;
  }
};

const start = async () => {
  console.log(`[claude-status] starting; state file = ${STATE_FILE}`);

  const settings: AppSettings = {
    [SETTING_IDS.INTERVAL]: {
      id: SETTING_IDS.INTERVAL,
      label: "Refresh Interval (seconds)",
      type: SETTING_TYPES.NUMBER,
      value: DEFAULTS.interval,
      min: 0.5,
      max: 30,
      description: "How often to re-read the Claude session state file.",
    },
    [SETTING_IDS.SHOW_DONE]: {
      id: SETTING_IDS.SHOW_DONE,
      label: "Show finished sessions",
      type: SETTING_TYPES.BOOLEAN,
      value: DEFAULTS.showDone,
      description: "Include sessions that have finished responding.",
    },
  };

  await DeskThing.initSettings(settings);

  // Read settings exactly once at boot, then only ever from the event below.
  try {
    applySettings(await DeskThing.getSettings());
  } catch {
    /* keep defaults */
  }

  DeskThing.on(CLIENT_TYPE.STATUS, async (data) => {
    if (data.request === "get") await pushStatus(data.clientId);
  });

  DeskThing.on(DESKTHING_EVENTS.SETTINGS, (event) => {
    const before = cfg.interval;
    applySettings(event?.payload as AppSettings | undefined);
    lastSerialized = "";
    // Only re-arm when the interval genuinely changed. This is the guard that
    // prevents the stacking loop that caused EMFILE.
    if (cfg.interval !== before) {
      armPolling(Math.max(250, cfg.interval * 1000));
    }
    void pushStatus(undefined, true);
  });

  armPolling(Math.max(250, cfg.interval * 1000));
  await pushStatus(undefined, true);
  console.log("[claude-status] ready");
};

const stop = async () => {
  if (typeof cancelPoll === "function") {
    try {
      cancelPoll();
    } catch {
      /* ignore */
    }
  }
  cancelPoll = null;
  armedIntervalMs = 0;
  lastSerialized = "";
  reading = false;
  console.log("[claude-status] stopped");
};

DeskThing.on(DESKTHING_EVENTS.START, start);
DeskThing.on(DESKTHING_EVENTS.STOP, stop);

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
import { open, readFile, stat } from "node:fs/promises";
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

/* ---------------------------------------------------------------------------
 * Recaps: Claude Code's own "away summary", pulled out of the transcript.
 *
 * About three minutes after a turn ends - and only while the terminal is
 * unfocused - Claude appends a system record of subtype "away_summary" to the
 * session's .jsonl: under 40 words, plain sentences, no markdown, written for
 * someone walking back to a screen. That is a better headline for a display
 * read from across the room than the first paragraph of a long reply, so the
 * client shows it above the reply rather than instead of it.
 *
 * No hook fires when one is written, which is why this is here and not in
 * claude-status.ps1: the file has to be watched.
 * ------------------------------------------------------------------------- */

/** Only the tail is ever read. A recap is the last thing written to a session's
 *  transcript, and these files reach tens of megabytes. */
const TAIL_BYTES = 64 * 1024;

/** Claude appends this to a session's first few recaps. It is a hint for the
 *  terminal, not part of the summary, and it is noise on an 800x480 screen. */
const RECAP_FOOTER = /\s*\(disable recaps in \/config\)\s*$/;

type Recap = { text: string; at: string };

/** Re-reading an unchanged file every second would be pure waste, so results
 *  are held against the file's size and mtime and only recomputed when the
 *  transcript actually grows. */
const recapCache = new Map<
  string,
  { size: number; mtimeMs: number; recap: Recap | null }
>();

const parseRecap = (chunk: string, truncated: boolean): Recap | null => {
  const lines = chunk.split("\n");
  // When the read started mid-file, line 0 is the tail of a record that began
  // before the window and cannot be parsed. When it did not, line 0 is a whole
  // record like any other.
  const first = truncated ? 1 : 0;
  for (let i = lines.length - 1; i >= first; i--) {
    const line = lines[i];
    // Cheap reject first: JSON.parse on every line of 64 KB, once a second,
    // is the kind of thing that turns a status board into a space heater.
    if (!line.includes("away_summary")) continue;
    try {
      const rec = JSON.parse(line);
      if (rec?.type === "system" && rec?.subtype === "away_summary") {
        const text = String(rec.content ?? "").replace(RECAP_FOOTER, "").trim();
        if (text && typeof rec.timestamp === "string") {
          return { text, at: rec.timestamp };
        }
      }
    } catch {
      /* a torn line mid-write - the next poll gets it */
    }
  }
  return null;
};

const readRecap = async (path: string): Promise<Recap | null> => {
  let size: number;
  let mtimeMs: number;
  try {
    const st = await stat(path);
    size = st.size;
    mtimeMs = st.mtimeMs;
  } catch {
    recapCache.delete(path);
    return null;
  }

  const hit = recapCache.get(path);
  if (hit && hit.size === size && hit.mtimeMs === mtimeMs) return hit.recap;

  let recap: Recap | null = null;
  let fh;
  try {
    fh = await open(path, "r");
    const len = Math.min(TAIL_BYTES, size);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, Math.max(0, size - len));
    recap = parseRecap(buf.toString("utf-8"), size > len);
  } catch {
    recap = null;
  } finally {
    await fh?.close().catch(() => {});
  }

  recapCache.set(path, { size, mtimeMs, recap });
  return recap;
};

/** Forget transcripts belonging to sessions that no longer exist, so a machine
 *  left running for a week does not accumulate an entry per session ever seen. */
const pruneRecapCache = (live: Set<string>) => {
  for (const path of recapCache.keys()) {
    if (!live.has(path)) recapCache.delete(path);
  }
};

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
      // Newest first. Fall back to the single message so a state file written
      // by an older hook still renders.
      messages: Array.isArray(v.messages)
        ? (v.messages as string[]).filter((m) => typeof m === "string" && m.trim())
        : v.message
        ? [String(v.message)]
        : undefined,
      transcript: v.transcript || undefined,
    }))
    .sort((a, b) => {
      if (a.state === "blocked" && b.state !== "blocked") return -1;
      if (b.state === "blocked" && a.state !== "blocked") return 1;
      return (b.updated || "").localeCompare(a.updated || "");
    });

  await attachRecaps(sessions);

  return { sessions, updated: now };
};

/**
 * Hang each session's recap off it, if it has one that belongs to the reply
 * currently on screen.
 *
 * The timestamp test is the whole correctness argument. `updated` is when the
 * session last reported - for a finished turn, when it finished - so a recap
 * newer than that describes THIS turn, and one older describes a turn that has
 * already been superseded. Without it, submitting a new prompt would leave the
 * previous turn's summary sitting over the new reply as though it described it.
 */
const attachRecaps = async (sessions: ClaudeSession[]) => {
  const live = new Set<string>();

  await Promise.all(
    sessions.map(async (s) => {
      if (!s.transcript) return;
      live.add(s.transcript);

      const recap = await readRecap(s.transcript);
      if (!recap) return;

      const at = Date.parse(recap.at);
      const updated = Date.parse(s.updated);
      if (!Number.isFinite(at) || !Number.isFinite(updated) || at <= updated) return;

      s.recap = recap.text;
      s.recapAt = recap.at;
    })
  );

  pruneRecapCache(live);
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

    // The device never needs the path, and shipping it would put a chunk of
    // unchanging string into every diff and every websocket frame.
    for (const s of payload.sessions) delete s.transcript;

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

  /* -----------------------------------------------------------------------
   * Push whenever a client attaches.
   *
   * The poll only broadcasts on CHANGE, which is right for a once-a-second
   * timer but wrong for a client that shows up later: if nothing has changed
   * since the last broadcast, a freshly opened app would wait forever for a
   * message that never comes and sit on its empty state. The client's own
   * request-on-mount covers this only when it does not time out, and it does
   * time out. So the server pushes on connect too.
   * --------------------------------------------------------------------- */
  DeskThing.on(DESKTHING_EVENTS.CLIENT_STATUS, (data) => {
    if (data?.request === "opened" || data?.request === "connected") {
      console.log(`[claude-status] client ${data.request}; pushing current state`);
      void pushStatus(undefined, true);
    }
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

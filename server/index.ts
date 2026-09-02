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
/* ---------------------------------------------------------------------------
 * Read marks: the device's own opinion, and nobody else's.
 *
 * "done" is only interesting while it means finished AND unread - once you have
 * actually looked at the reply, a green row shouting for attention is noise.
 * Marking one read changes nothing in Claude Code: no hook, no state file, no
 * effect on the terminal session, which is exactly what was asked for.
 *
 * Held in memory and mirrored into the app's own saved data, so it survives
 * switching to the clock and back, and a DeskThing restart. Keyed by session id
 * against the `updated` that was read, so the next turn that session finishes
 * is unread again with no state to expire or clear.
 *
 * NEVER read or written from the poll path. v0.1.0 called getSettings() on
 * every tick and stacked intervals until the process ran out of file
 * descriptors; the same discipline applies to saved data.
 * ------------------------------------------------------------------------- */
const READ_KEY = "readAt";
/** The hook prunes a finished session from the state file long before this, so
 *  a mark older than a couple of days can only belong to a session that no
 *  longer exists. Generous on purpose: it is a few bytes against forgetting
 *  that you read something. */
const READ_MARK_TTL_MS = 3 * 24 * 60 * 60 * 1000;
let readMarks: Record<string, string> = {};

let cfg = { ...DEFAULTS };
let cancelPoll: (() => void) | null = null;
let armedIntervalMs = 0;
let lastSerialized = "";
let reading = false;

const VALID_STATES: SessionState[] = ["blocked", "working", "idle", "done"];

/* ---------------------------------------------------------------------------
 * What the transcript tells us that the hook cannot.
 *
 * Two things are read out of each session's .jsonl on every poll.
 *
 * 1. THE RECAP - Claude Code's own "away summary".
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
 *
 * 2. LAST ACTIVITY - the timestamp of the newest user or assistant record.
 *
 * The hook only fires at prompt-submit and turn-end, so between those two
 * moments the state file is frozen and says nothing. That produced two visible
 * lies. A session blocked on a permission prompt stayed "waiting on you" after
 * the prompt was answered, right up until the whole turn finished. And a long
 * turn, which is silent for its entire duration, was indistinguishable from a
 * killed one and decayed to "no word" while it was working perfectly.
 *
 * The transcript is appended to throughout, so it settles both. Answering a
 * permission prompt lets the tool run, and its result lands here - there is no
 * earlier signal anywhere: Claude Code writes no permission-decision record and
 * PostToolUse fires at exactly the same moment, for the price of spawning
 * PowerShell on every tool call.
 *
 * Only user and assistant records count. The system ones (turn_duration,
 * stop_hook_summary, away_summary) are written AFTER a turn ends and would
 * make a finished session look like it was still going.
 * ------------------------------------------------------------------------- */

/** Only the tail is ever read. A recap is the last thing written to a session's
 *  transcript, and these files reach tens of megabytes. */
const TAIL_BYTES = 64 * 1024;

/** Claude appends this to a session's first few recaps. It is a hint for the
 *  terminal, not part of the summary, and it is noise on an 800x480 screen. */
const RECAP_FOOTER = /\s*\(disable recaps in \/config\)\s*$/;

type Recap = { text: string; at: string };

/** What one pass over a transcript's tail yields. */
type TranscriptRead = {
  recap: Recap | null;
  /** ISO timestamp of the newest user/assistant record, or null if the window
   *  held none (a turn whose tool output alone exceeds the tail). */
  lastActivity: string | null;
};

/** Re-reading an unchanged file every second would be pure waste, so results
 *  are held against the file's size and mtime and only recomputed when the
 *  transcript actually grows. */
const transcriptCache = new Map<
  string,
  { size: number; mtimeMs: number; read: TranscriptRead }
>();

const parseTranscript = (chunk: string, truncated: boolean): TranscriptRead => {
  const lines = chunk.split("\n");
  // When the read started mid-file, line 0 is the tail of a record that began
  // before the window and cannot be parsed. When it did not, line 0 is a whole
  // record like any other.
  const first = truncated ? 1 : 0;

  let recap: Recap | null = null;
  let lastActivity: string | null = null;

  for (let i = lines.length - 1; i >= first; i--) {
    const line = lines[i];

    // Cheap string tests before JSON.parse. Running the parser over every line
    // of 64 KB once a second is the kind of thing that turns a status board
    // into a space heater, and one tool_result line alone can be megabytes.
    const isRecap = !recap && line.includes("away_summary");
    const isTurn =
      !lastActivity &&
      (line.includes('"type":"assistant"') || line.includes('"type":"user"'));
    if (!isRecap && !isTurn) continue;

    try {
      const rec = JSON.parse(line);

      if (isRecap && rec?.type === "system" && rec?.subtype === "away_summary") {
        const text = String(rec.content ?? "").replace(RECAP_FOOTER, "").trim();
        if (text && typeof rec.timestamp === "string") recap = { text, at: rec.timestamp };
      }

      if (
        !lastActivity &&
        (rec?.type === "assistant" || rec?.type === "user") &&
        typeof rec.timestamp === "string"
      ) {
        lastActivity = rec.timestamp;
      }
    } catch {
      /* a torn line mid-write - the next poll gets it */
    }

    // Walking backwards, so the first of each found is the newest.
    if (recap && lastActivity) break;
  }

  return { recap, lastActivity };
};

const EMPTY_READ: TranscriptRead = { recap: null, lastActivity: null };

const readTranscript = async (path: string): Promise<TranscriptRead> => {
  let size: number;
  let mtimeMs: number;
  try {
    const st = await stat(path);
    size = st.size;
    mtimeMs = st.mtimeMs;
  } catch {
    transcriptCache.delete(path);
    return EMPTY_READ;
  }

  const hit = transcriptCache.get(path);
  if (hit && hit.size === size && hit.mtimeMs === mtimeMs) return hit.read;

  let read: TranscriptRead = EMPTY_READ;
  let fh;
  try {
    fh = await open(path, "r");
    const len = Math.min(TAIL_BYTES, size);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, Math.max(0, size - len));
    read = parseTranscript(buf.toString("utf-8"), size > len);
  } catch {
    read = EMPTY_READ;
  } finally {
    await fh?.close().catch(() => {});
  }

  transcriptCache.set(path, { size, mtimeMs, read });
  return read;
};

/** Forget transcripts belonging to sessions that no longer exist, so a machine
 *  left running for a week does not accumulate an entry per session ever seen. */
const pruneTranscriptCache = (live: Set<string>) => {
  for (const path of transcriptCache.keys()) {
    if (!live.has(path)) transcriptCache.delete(path);
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
      readAt: readMarks[id],
    }))
    .sort((a, b) => {
      if (a.state === "blocked" && b.state !== "blocked") return -1;
      if (b.state === "blocked" && a.state !== "blocked") return 1;
      return (b.updated || "").localeCompare(a.updated || "");
    });

  await reconcileWithTranscripts(sessions);

  return { sessions, updated: now };
};

/**
 * Correct each session against its own transcript.
 *
 * Two independent corrections, both resting on the same timestamp comparison
 * against `updated` - when the session last REPORTED through the hook.
 *
 * RECAP: attached only when newer than `updated`, so it describes the reply
 * currently on screen. An older one belongs to a turn already superseded, and
 * would otherwise sit over a new reply as though it described it.
 *
 * LIVENESS: a session that is working or blocked, whose transcript has moved
 * since it last reported, is demonstrably still going. Its clock is moved
 * forward to that activity, and a blocked one is released: the permission
 * prompt has been answered, because the tool it was waiting on has since
 * written its result.
 *
 * Deliberately NOT applied to done or idle. Those states mean the session
 * stopped on purpose, and the only records written after a turn ends are
 * system ones this scan already ignores - but if that ever changes, a finished
 * session must not be resurrected by its own epilogue.
 */
const reconcileWithTranscripts = async (sessions: ClaudeSession[]) => {
  const live = new Set<string>();

  await Promise.all(
    sessions.map(async (s) => {
      if (!s.transcript) return;
      live.add(s.transcript);

      const { recap, lastActivity } = await readTranscript(s.transcript);
      const updated = Date.parse(s.updated);
      if (!Number.isFinite(updated)) return;

      if (recap) {
        const at = Date.parse(recap.at);
        if (Number.isFinite(at) && at > updated) {
          s.recap = recap.text;
          s.recapAt = recap.at;
        }
      }

      if (!lastActivity) return;
      if (s.state !== "working" && s.state !== "blocked") return;

      const active = Date.parse(lastActivity);
      if (!Number.isFinite(active) || active <= updated) return;

      s.updated = lastActivity;
      if (s.state === "blocked") s.state = "working";
    })
  );

  pruneTranscriptCache(live);
};

/**
 * Write the read marks back to the app's saved data.
 *
 * Called only when a mark actually changes - never on the poll path. Ids
 * accumulate forever otherwise, so this is also where the map is trimmed: a
 * session that has aged out of the state file cannot be read again, and its
 * mark is dead weight.
 */
const persistReadMarks = () => {
  const cutoff = Date.now() - READ_MARK_TTL_MS;
  for (const [id, at] of Object.entries(readMarks)) {
    const t = Date.parse(at);
    if (!Number.isFinite(t) || t < cutoff) delete readMarks[id];
  }
  try {
    DeskThing.saveData({ [READ_KEY]: { ...readMarks } });
  } catch (err) {
    console.warn("[claude-status] could not save read marks", err);
  }
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

  try {
    const saved = await DeskThing.getData();
    const marks = saved?.[READ_KEY];
    if (marks && typeof marks === "object") {
      for (const [id, at] of Object.entries(marks as Record<string, unknown>)) {
        if (typeof at === "string" && Number.isFinite(Date.parse(at))) readMarks[id] = at;
      }
    }
    console.log(`[claude-status] restored ${Object.keys(readMarks).length} read marks`);
  } catch {
    /* an unreadable mark file just means everything reads as unread */
  }

  DeskThing.on(CLIENT_TYPE.STATUS, async (data) => {
    if (data.request === "get") await pushStatus(data.clientId);
  });

  DeskThing.on(CLIENT_TYPE.MARK_READ, (data) => {
    const mark = data?.payload;
    if (!mark?.id || !mark?.at || !Number.isFinite(Date.parse(mark.at))) return;

    // Only ever move forward. Messages can arrive out of order, and a stale one
    // must not un-read a turn that has since been read.
    const held = readMarks[mark.id];
    if (held && Date.parse(held) >= Date.parse(mark.at)) return;
    readMarks[mark.id] = mark.at;

    persistReadMarks();
    // The payload genuinely changed, so let the next push through the
    // change filter and send it now.
    lastSerialized = "";
    void pushStatus(undefined, true);
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

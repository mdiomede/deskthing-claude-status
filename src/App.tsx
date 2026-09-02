import React, { useEffect, useMemo, useRef, useState } from "react";
import { createDeskThing } from "@deskthing/client";
import { EventMode } from "@deskthing/types";
import {
  CLIENT_TYPE,
  SERVER_TYPE,
  ClaudeSession,
  SessionState,
  StatusPayload,
  ToClientData,
  ToServerData,
} from "../shared/transit";

const DeskThing = createDeskThing<ToClientData, ToServerData>();

/**
 * A session that says "working" but has not reported in for this long is not
 * really working. Claude Code does not emit Stop when a turn is interrupted
 * with Esc, so without this a killed session claims to work forever.
 */
const STALE_AFTER_MS = 3 * 60 * 1000;

/**
 * After this long with no event at all, we stop believing the reported state.
 * Closing a terminal window does not reliably fire SessionEnd, so a dead
 * session would otherwise sit at "idle" or "done" looking alive until the
 * hook's 24h prune. Silence is not liveness.
 */
const GONE_AFTER_MS = 30 * 60 * 1000;

/**
 * How long a finished session has to sit on screen before it counts as read.
 *
 * Long enough that flicking through the rail does not mark everything read on
 * the way past, short enough that a genuine glance counts - the board exists to
 * be read from across the room without touching it, so requiring a tap would
 * miss the normal way it gets used.
 */
const READ_DWELL_MS = 4000;

type DisplayState = SessionState | "read" | "stale" | "gone";

const secondsSince = (iso: string): number => {
  const then = Date.parse(iso);
  return Number.isNaN(then) ? 0 : Math.max(0, (Date.now() - then) / 1000);
};

const displayState = (s: ClaudeSession): DisplayState => {
  // Only "working" decays with silence.
  //
  // done / idle / blocked are SUPPOSED to be quiet - the turn finished, or it
  // is waiting on a human. Ageing those into "gone quiet" after 30 minutes
  // mislabelled precisely the sessions worth reading hours later: prompt here,
  // switch the monitor to the work machine, come back and read the answer off
  // this screen. A finished session is not a dead one.
  //
  // "working" is different. The hook fires only at prompt-submit and turn-end,
  // so a long turn reports nothing for its whole duration and looks identical
  // to a killed one; decaying it is the honest way to say "I cannot tell any
  // more". The server now moves `updated` forward from the transcript, which
  // IS written throughout a turn, so this decay finally means what it says: a
  // working session goes quiet here only when the transcript has stopped too.
  // "done" is only worth a bright row while it means finished AND UNREAD. Once
  // it has been read on the device it keeps its place in the order but stops
  // shouting. The mark is held against the `updated` that was read, so the
  // next turn this session finishes is unread again on its own.
  if (s.state === "done" && s.readAt) {
    const read = Date.parse(s.readAt);
    const updated = Date.parse(s.updated);
    if (Number.isFinite(read) && Number.isFinite(updated) && read >= updated) {
      return "read";
    }
  }

  if (s.state !== "working") return s.state;

  const ageMs = secondsSince(s.updated) * 1000;
  if (ageMs > GONE_AFTER_MS) return "gone";
  if (ageMs > STALE_AFTER_MS) return "stale";
  return s.state;
};

const LABEL: Record<DisplayState, string> = {
  blocked: "waiting on you",
  working: "working",
  done: "done",
  read: "read",
  idle: "idle",
  stale: "no word",
  gone: "gone quiet",
};

// Each state gets its own hue in the rail so the board is readable at a glance
// without reading a word of it. Amber is still reserved for "waiting on you" -
// nothing else uses that hue, and stale only gets a dimmed version of it,
// because a session that stopped reporting is a weaker form of the same news.
// The two dead states stay grey: absence of colour means absence of activity.
const TONE: Record<DisplayState, string> = {
  blocked: "text-signal",
  working: "text-live",
  done: "text-good",
  read: "text-gooddim",
  idle: "text-muted",
  stale: "text-signaldim",
  gone: "text-faint",
};

const DOT: Record<DisplayState, string> = {
  blocked: "bg-signal",
  working: "bg-live",
  done: "bg-good",
  read: "bg-gooddim",
  idle: "bg-muted",
  stale: "bg-signaldim",
  gone: "bg-groundup",
};

// Live sessions first, anything that has gone quiet last.
const ORDER: Record<DisplayState, number> = {
  blocked: 0,
  working: 1,
  done: 2,
  read: 3,
  idle: 4,
  stale: 5,
  gone: 6,
};

const elapsed = (iso: string): string => {
  const s = Math.round(secondsSince(iso));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
};

/* -------------------------------------------------------------------------- */
/* Alert: nothing else matters when something is waiting on you.               */
/* -------------------------------------------------------------------------- */

const Alert: React.FC<{ blocked: ClaudeSession[]; others: number }> = ({
  blocked,
  others,
}) => {
  const lead = blocked[0];
  return (
    <div className="flex h-screen w-screen animate-breathe flex-col justify-between bg-signal px-10 py-9 text-ground">
      <div className="flex items-baseline justify-between">
        <span className="text-tag font-bold uppercase">Waiting on you</span>
        <span className="text-tag font-semibold uppercase opacity-70">
          {elapsed(lead.updated)}
        </span>
      </div>

      <div className="min-w-0">
        <div
          className={`truncate font-black ${
            blocked.length > 1 ? "text-headline" : "text-blast"
          }`}
        >
          {lead.project}
        </div>
        {blocked.length > 1 && (
          <div className="mt-4 flex flex-wrap gap-x-6 gap-y-1">
            {blocked.slice(1).map((s) => (
              <span key={s.id} className="text-row font-bold opacity-80">
                {s.project}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="text-tag font-semibold uppercase opacity-60">
        {blocked.length > 1
          ? `${blocked.length} sessions blocked`
          : others > 0
          ? `${others} other running`
          : "nothing else running"}
      </div>
    </div>
  );
};

/* -------------------------------------------------------------------------- */
/* Reader: a compact session strip, then the last reply, scrollable.           */
/* -------------------------------------------------------------------------- */

const Reader: React.FC<{
  sessions: ClaudeSession[];
  error?: string;
}> = ({ sessions, error }) => {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // 0 = newest reply. Lets you page back through what a session said earlier.
  const [msgIndex, setMsgIndex] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);

  const ordered = useMemo(
    () =>
      [...sessions].sort(
        (a, b) => ORDER[displayState(a)] - ORDER[displayState(b)]
      ),
    [sessions]
  );

  // Default to the liveliest session, and honour a manual pick - but only
  // while the picked session is still alive.
  //
  // selectedId used to be sticky forever, so once you tapped anything the
  // content pane stayed welded to it even after that session died. The rail
  // still listed the live session; the pane you were reading was a corpse's
  // last message, which is indistinguishable from "the app stopped updating".
  // A board about what is happening now must not pin itself to what happened.
  const picked = ordered.find((s) => s.id === selectedId);
  const selected =
    (picked && displayState(picked) !== "gone" ? picked : null) ??
    ordered[0] ??
    null;

  // Drop a selection once its session has gone quiet, so the next render is
  // free to follow the live one rather than re-resolving a dead id every time.
  useEffect(() => {
    if (picked && displayState(picked) === "gone") setSelectedId(null);
  }, [picked, sessions]);

  // A different session starts at its newest reply, not wherever you had paged
  // to in the previous one.
  useEffect(() => {
    setMsgIndex(0);
  }, [selected?.id]);

  /* -----------------------------------------------------------------------
   * Marking a session read.
   *
   * Two triggers. Tapping a row in the rail is explicit and immediate. And a
   * finished session left on screen for a few seconds has been read whether or
   * not anything was touched - that is how this display is actually used.
   *
   * The dwell only runs while the document is VISIBLE, so leaving the app open
   * behind the clock does not quietly mark everything read. The sent set is
   * keyed by session AND by the turn that was read, so the next turn it
   * finishes is unread again and will be sent once more.
   *
   * Nothing here reaches Claude Code. It is the device's own opinion.
   * --------------------------------------------------------------------- */
  const sent = useRef<Set<string>>(new Set());
  const markRead = (s: ClaudeSession | null | undefined) => {
    if (!s || s.state !== "done") return;
    const key = `${s.id}@${s.updated}`;
    if (sent.current.has(key)) return;
    sent.current.add(key);
    DeskThing.send({
      type: CLIENT_TYPE.MARK_READ,
      request: "set",
      payload: { id: s.id, at: s.updated },
    });
  };

  const [visible, setVisible] = useState(
    typeof document === "undefined" || document.visibilityState !== "hidden"
  );
  useEffect(() => {
    const onVis = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  useEffect(() => {
    if (!visible || !selected || selected.state !== "done") return;
    const s = selected;
    const t = setTimeout(() => markRead(s), READ_DWELL_MS);
    return () => clearTimeout(t);
  }, [visible, selected?.id, selected?.updated, selected?.state]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [selected?.id, msgIndex, selected?.message]);

  // Newest first. Older hooks wrote only `message`, so fall back to it rather
  // than showing an empty pane after an app update.
  const history: string[] =
    selected?.messages && selected.messages.length
      ? selected.messages
      : selected?.message
      ? [selected.message]
      : [];
  const idx = Math.min(msgIndex, Math.max(0, history.length - 1));
  const body = history[idx];

  // The recap describes the LATEST turn, so it only belongs over the latest
  // reply. Paged back to an earlier one, it would be a summary of a different
  // conversation sitting on top of the text it does not describe.
  const showRecap = idx === 0 && Boolean(selected?.recap);

  /* -----------------------------------------------------------------------
   * Take the wheel.
   *
   * @deskthing/client runs inside this iframe and listens for "wheel" on
   * document in the capture phase, forwarding it to the server as a Scroll
   * key -- which is what makes the wheel change apps. overrideKeys("wheel")
   * suppresses that forwarding so the event stays here and scrolls the text.
   *
   * The key string must be "wheel". The JSDoc suggests "Scroll", but the
   * client checks keyOverrides.has('wheel') literally, so "Scroll" does
   * nothing. Restore on unmount or the wheel stays dead in other apps.
   * --------------------------------------------------------------------- */
  useEffect(() => {
    DeskThing.overrideKeys(["wheel"]);

    /* -----------------------------------------------------------------------
     * Make the four physical preset buttons work while this app is open.
     *
     * DeskThing's client shell listens for the button keydowns on ITS document.
     * The moment an app's iframe takes focus the events land in the iframe
     * instead, and key events do not cross document boundaries - so the shell
     * never sees them and the buttons go dead until you swipe back out. The
     * client library attaches no key listener of its own (it only listens for
     * postMessage), so nothing forwards them on your behalf.
     *
     * triggerKey is the supported way back: catch the key here and hand it to
     * the shell, which runs whatever the mapping has bound to it. That keeps
     * the binding as the single source of truth - this does not hardcode which
     * app each button opens, so remapping in the UI still works.
     *
     * PressShort (10) is deliberate: mode 11 (PressLong) never fires on this
     * client, so mode 10 is the only one the bindings actually use.
     * --------------------------------------------------------------------- */
    const onPresetKey = (e: KeyboardEvent) => {
      if (!/^Digit[1-4]$/.test(e.code)) return;
      e.preventDefault();
      // KeyReference is { id, mode, source } - the library's own JSDoc says
      // `key`, which does not compile. Trust the type, not the comment.
      void DeskThing.triggerKey({
        id: e.code,
        mode: EventMode.PressShort,
        source: "server",
      });
    };
    window.addEventListener("keydown", onPresetKey);
    document.addEventListener("keydown", onPresetKey);


    let logged = 0;

    const onWheel = (e: WheelEvent) => {
      // Log the first few so we can see what the dial actually reports. A
      // Math.sign(deltaY) step scrolls by zero if the device sends horizontal
      // delta instead, which looks identical to "the wheel does nothing".
      if (logged < 5) {
        logged++;
        console.log(
          `[claude-status] wheel dY=${e.deltaY} dX=${e.deltaX} mode=${e.deltaMode}`
        );
      }

      const el = scroller.current;
      if (!el) return;

      const raw = e.deltaY !== 0 ? e.deltaY : e.deltaX;
      if (raw === 0) return;
      el.scrollBy({ top: Math.sign(raw) * 90, behavior: "auto" });
    };

    // Listen on both: the client attaches to document in the capture phase,
    // and depending on where the event originates it may not reach window.
    window.addEventListener("wheel", onWheel, { passive: true });
    document.addEventListener("wheel", onWheel, { passive: true });
    return () => {
      window.removeEventListener("keydown", onPresetKey);
      document.removeEventListener("keydown", onPresetKey);
      window.removeEventListener("wheel", onWheel);
      document.removeEventListener("wheel", onWheel);
      DeskThing.restoreKeys(["wheel"]);
    };
  }, []);

  /* Both horizontal edges belong to the system: the top is the pull-down bar,
     the bottom is the now-playing bar (client chrome, present even with no
     audio app installed). So session switching lives in a LEFT RAIL. The
     screen is 800x480, so width is the affordable dimension, and neither
     system gesture is horizontal. Vertical padding keeps the first and last
     rail items clear of both edges. */
  return (
    <div className="flex h-screen w-screen bg-ground">
      {/* left rail: the only interactive region */}
      <div className="flex w-[13.5rem] shrink-0 flex-col gap-1 overflow-y-auto border-r border-rule px-3 py-6">
        {ordered.length === 0 ? (
          <div className="px-2 text-tag font-bold uppercase text-faint">
            No sessions
          </div>
        ) : (
          ordered.map((s) => {
            const st = displayState(s);
            const active = selected?.id === s.id;
            return (
              <button
                key={s.id}
                onClick={() => {
                  setSelectedId(s.id);
                  markRead(s);
                }}
                className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left ${
                  active ? "bg-groundup" : ""
                }`}
              >
                <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[st]}`} />
                <span className="min-w-0 flex-1">
                  <span
                    className={`block truncate text-lg font-bold leading-tight ${
                      active ? "text-bone" : "text-muted"
                    }`}
                  >
                    {s.project}
                  </span>
                  <span
                    className={`block truncate text-[0.7rem] font-semibold uppercase tracking-wider ${TONE[st]}`}
                  >
                    {LABEL[st]}
                  </span>
                </span>
              </button>
            );
          })
        )}
      </div>

      {/* reading column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Read-only header: no touch targets near the top edge. */}
        <div className="flex shrink-0 items-baseline justify-between px-7 pb-2 pt-6">
          <span className="min-w-0 truncate text-row font-bold text-bone">
            {selected ? selected.project : "Claude"}
          </span>
          {selected && (
            <span className="ml-4 shrink-0 text-tag font-medium tabular-nums text-faint">
              {elapsed(selected.updated)}
            </span>
          )}
        </div>

        {error ? (
          <div className="flex min-h-0 flex-1 items-center px-7">
            <p className="text-row font-bold text-signaldim">{error}</p>
          </div>
        ) : !selected ? (
          <div className="flex min-h-0 flex-1 flex-col justify-center px-7">
            <p className="text-headline font-black leading-none text-groundup">
              idle
            </p>
            <p className="mt-3 text-tag font-semibold uppercase text-faint">
              Nothing running
            </p>
          </div>
        ) : (
          <div
            ref={scroller}
            className="min-h-0 flex-1 overflow-y-auto px-7 pb-8"
            style={{ WebkitOverflowScrolling: "touch" }}
          >
            {/* History pager. Sits under the header, not in it: the top edge is
                the system pull-down and the bottom is the now-playing bar, so
                touch targets have to live in the middle band. Hidden entirely
                when there is only one reply - no dead chrome. */}
            {/* The recap leads.
                Claude writes it for someone returning to a screen - under 40
                words, plain sentences - which is the same job this display has
                from across the room. It is a headline for the reply, never a
                replacement: the full text is right underneath, unabridged. */}
            {showRecap && (
              <>
                <p className="mb-2 text-tag font-semibold uppercase text-faint">
                  Where it stands
                </p>
                <p className="text-recap font-semibold text-bone">
                  {selected.recap}
                </p>
                <div className="mb-4 mt-5 flex items-center gap-3">
                  <span className="shrink-0 text-tag font-semibold uppercase text-faint">
                    Full reply
                  </span>
                  <span className="h-px flex-1 bg-rule" />
                </div>
              </>
            )}

            {history.length > 1 && (
              <div className="mb-3 flex items-center gap-3">
                <button
                  onClick={() => setMsgIndex((i) => Math.min(history.length - 1, i + 1))}
                  className={`rounded-lg px-3 py-1.5 text-lg font-bold ${
                    idx >= history.length - 1 ? "text-groundup" : "bg-groundup text-bone"
                  }`}
                >
                  &#8249; older
                </button>
                <span className="text-tag font-semibold uppercase tabular-nums text-faint">
                  {idx === 0 ? "latest" : `${idx + 1} of ${history.length}`}
                </span>
                <button
                  onClick={() => setMsgIndex((i) => Math.max(0, i - 1))}
                  className={`rounded-lg px-3 py-1.5 text-lg font-bold ${
                    idx === 0 ? "text-groundup" : "bg-groundup text-bone"
                  }`}
                >
                  newer &#8250;
                </button>
              </div>
            )}

            {body ? (
              <p className="whitespace-pre-wrap break-words text-[1.3rem] leading-[1.45] text-bonedim">
                {body}
              </p>
            ) : (
              <p className="pt-6 text-row font-bold text-groundup">
                No reply captured yet
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

const App: React.FC = () => {
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;

    // Ask the server for current state, and keep asking until we get an answer.
    //
    // A single request is not enough: the server's poll only broadcasts on
    // CHANGE, so if nothing has changed since it started, a client that opens
    // later gets no broadcast at all. This request is the only thing that
    // populates the screen in that case, and it times out at 500ms while the
    // app is still booting. So retry with backoff instead of giving up.
    const load = async (attempt = 0) => {
      if (cancelled) return;
      try {
        const res = await DeskThing.fetch(
          { type: CLIENT_TYPE.STATUS, request: "get", payload: undefined },
          { type: SERVER_TYPE.STATUS, request: "update" }
        );
        if (!cancelled && res?.payload) {
          setStatus(res.payload);
          return;
        }
      } catch {
        /* fall through to retry */
      }
      if (!cancelled && attempt < 6) {
        setTimeout(() => load(attempt + 1), 400 + attempt * 600);
      }
    };
    load();

    const off = DeskThing.on(SERVER_TYPE.STATUS, (data) => {
      if (data.payload) setStatus(data.payload);
    });

    const t = setInterval(() => setTick((n) => n + 1), 5000);

    return () => {
      cancelled = true;
      off();
      clearInterval(t);
    };
  }, []);

  const sessions = status?.sessions ?? [];

  const { blocked, running } = useMemo(() => {
    const blocked = sessions.filter((s) => displayState(s) === "blocked");
    return {
      blocked,
      // "Other running" has to mean sessions that ARE running.
      //
      // This counted every non-blocked session, so a finished one, an idle
      // window and a terminal closed an hour ago all read as "running" - and
      // because none of that changes until the hook's prune hours later, the
      // number sat there being wrong for the whole time the alert was up.
      // Counting the working ones makes it fall as they finish, on the five
      // second tick, with no push from the server needed.
      running: sessions.filter((s) => displayState(s) === "working").length,
    };
  }, [sessions]);

  if (blocked.length > 0) {
    return <Alert blocked={blocked} others={running} />;
  }

  return <Reader sessions={sessions} error={status?.error} />;
};

export default App;

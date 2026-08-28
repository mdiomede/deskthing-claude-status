import React, { useEffect, useMemo, useRef, useState } from "react";
import { createDeskThing } from "@deskthing/client";
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

type DisplayState = SessionState | "stale" | "gone";

const secondsSince = (iso: string): number => {
  const then = Date.parse(iso);
  return Number.isNaN(then) ? 0 : Math.max(0, (Date.now() - then) / 1000);
};

const displayState = (s: ClaudeSession): DisplayState => {
  const ageMs = secondsSince(s.updated) * 1000;
  if (ageMs > GONE_AFTER_MS) return "gone";
  if (s.state === "working" && ageMs > STALE_AFTER_MS) return "stale";
  return s.state;
};

const LABEL: Record<DisplayState, string> = {
  blocked: "waiting on you",
  working: "working",
  done: "done",
  idle: "idle",
  stale: "no word",
  gone: "gone quiet",
};

// Only the alert state gets colour. Everything else is one warm greyscale, so
// brightness alone encodes how much you should care.
const TONE: Record<DisplayState, string> = {
  blocked: "text-signal",
  working: "text-bone",
  done: "text-bonedim",
  idle: "text-muted",
  stale: "text-faint",
  gone: "text-faint",
};

const DOT: Record<DisplayState, string> = {
  blocked: "bg-signal",
  working: "bg-bone",
  done: "bg-bonedim",
  idle: "bg-muted",
  stale: "bg-faint",
  gone: "bg-groundup",
};

// Live sessions first, anything that has gone quiet last.
const ORDER: Record<DisplayState, number> = {
  blocked: 0,
  working: 1,
  done: 2,
  idle: 3,
  stale: 4,
  gone: 5,
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
  const scroller = useRef<HTMLDivElement>(null);

  const ordered = useMemo(
    () =>
      [...sessions].sort(
        (a, b) => ORDER[displayState(a)] - ORDER[displayState(b)]
      ),
    [sessions]
  );

  // Default to the liveliest session, but never fight a manual pick.
  const selected =
    ordered.find((s) => s.id === selectedId) ?? ordered[0] ?? null;

  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [selected?.id, selected?.message]);

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
                onClick={() => setSelectedId(s.id)}
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
            {selected.message ? (
              <p className="whitespace-pre-wrap break-words text-[1.3rem] leading-[1.45] text-bonedim">
                {selected.message}
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

  const { blocked, rest } = useMemo(
    () => ({
      blocked: sessions.filter((s) => displayState(s) === "blocked"),
      rest: sessions.filter((s) => displayState(s) !== "blocked"),
    }),
    [sessions]
  );

  if (blocked.length > 0) {
    return <Alert blocked={blocked} others={rest.length} />;
  }

  return <Reader sessions={sessions} error={status?.error} />;
};

export default App;

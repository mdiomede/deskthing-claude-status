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

type DisplayState = SessionState | "stale";

const secondsSince = (iso: string): number => {
  const then = Date.parse(iso);
  return Number.isNaN(then) ? 0 : Math.max(0, (Date.now() - then) / 1000);
};

const displayState = (s: ClaudeSession): DisplayState =>
  s.state === "working" && secondsSince(s.updated) * 1000 > STALE_AFTER_MS
    ? "stale"
    : s.state;

const LABEL: Record<DisplayState, string> = {
  blocked: "waiting on you",
  working: "working",
  done: "done",
  idle: "idle",
  stale: "no word",
};

// Only the alert state gets colour. Everything else is one warm greyscale, so
// brightness alone encodes how much you should care.
const TONE: Record<DisplayState, string> = {
  blocked: "text-signal",
  working: "text-bone",
  done: "text-bonedim",
  idle: "text-muted",
  stale: "text-faint",
};

const DOT: Record<DisplayState, string> = {
  blocked: "bg-signal",
  working: "bg-bone",
  done: "bg-bonedim",
  idle: "bg-muted",
  stale: "bg-faint",
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

  // Default to the most recently updated session, but never fight a manual pick.
  const selected =
    sessions.find((s) => s.id === selectedId) ?? sessions[0] ?? null;

  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [selected?.id, selected?.message]);

  const page = (dir: 1 | -1) => {
    const el = scroller.current;
    if (!el) return;
    el.scrollBy({ top: dir * (el.clientHeight * 0.8), behavior: "smooth" });
  };

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

    const onWheel = (e: WheelEvent) => {
      const el = scroller.current;
      if (!el) return;
      // The dial reports coarse notches; scale them to a readable step.
      el.scrollBy({ top: Math.sign(e.deltaY) * 90, behavior: "auto" });
    };

    window.addEventListener("wheel", onWheel, { passive: true });
    return () => {
      window.removeEventListener("wheel", onWheel);
      DeskThing.restoreKeys(["wheel"]);
    };
  }, []);

  return (
    <div className="flex h-screen w-screen flex-col bg-ground">
      {/* session strip */}
      <div className="flex shrink-0 items-stretch gap-1 overflow-x-auto border-b border-rule px-4 pt-3">
        {sessions.length === 0 ? (
          <div className="px-4 pb-3 text-tag font-bold uppercase text-faint">
            No sessions
          </div>
        ) : (
          sessions.map((s) => {
            const st = displayState(s);
            const active = selected?.id === s.id;
            return (
              <button
                key={s.id}
                onClick={() => setSelectedId(s.id)}
                className={`flex min-w-0 shrink-0 items-center gap-2 border-b-2 px-3 pb-2 ${
                  active ? "border-bone" : "border-transparent"
                }`}
              >
                <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[st]}`} />
                <span
                  className={`max-w-[11rem] truncate text-lg font-bold ${
                    active ? "text-bone" : "text-muted"
                  }`}
                >
                  {s.project}
                </span>
              </button>
            );
          })
        )}
      </div>

      {/* body */}
      {error ? (
        <div className="flex flex-1 items-center px-8">
          <p className="text-row font-bold text-signaldim">{error}</p>
        </div>
      ) : !selected ? (
        <div className="flex flex-1 flex-col justify-center px-10">
          <p className="text-headline font-black leading-none text-groundup">
            idle
          </p>
          <p className="mt-3 text-tag font-semibold uppercase text-faint">
            Nothing running
          </p>
        </div>
      ) : (
        <>
          <div className="flex shrink-0 items-baseline justify-between px-8 pb-1 pt-3">
            <span
              className={`text-tag font-bold uppercase ${
                TONE[displayState(selected)]
              }`}
            >
              {LABEL[displayState(selected)]}
            </span>
            <span className="text-tag font-medium tabular-nums text-faint">
              {elapsed(selected.updated)}
            </span>
          </div>

          <div
            ref={scroller}
            className="min-h-0 flex-1 overflow-y-auto px-8 pb-4"
            style={{ WebkitOverflowScrolling: "touch" }}
          >
            {selected.message ? (
              <p className="whitespace-pre-wrap break-words text-[1.35rem] leading-[1.45] text-bonedim">
                {selected.message}
              </p>
            ) : (
              <p className="pt-6 text-row font-bold text-groundup">
                No reply captured yet
              </p>
            )}
          </div>

          {/* Touch works natively; these are the fallback for hardware keys. */}
          <div className="flex shrink-0 items-center justify-between border-t border-rule px-8 py-2">
            <button
              onClick={() => page(-1)}
              className="text-tag font-bold uppercase text-muted"
            >
              Up
            </button>
            <span className="text-tag font-medium uppercase text-faint">
              {selected.project}
            </span>
            <button
              onClick={() => page(1)}
              className="text-tag font-bold uppercase text-muted"
            >
              Down
            </button>
          </div>
        </>
      )}
    </div>
  );
};

const App: React.FC = () => {
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const res = await DeskThing.fetch(
          { type: CLIENT_TYPE.STATUS, request: "get", payload: undefined },
          { type: SERVER_TYPE.STATUS, request: "update" }
        );
        if (!cancelled && res?.payload) setStatus(res.payload);
      } catch {
        /* server still booting; the broadcast below will catch up */
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

// Wire protocol between the server half (Node, on the PC) and the client half
// (React, on the Car Thing). Both sides import these so the payloads stay typed.

export type SessionState = "blocked" | "working" | "idle" | "done";

export type ClaudeSession = {
  id: string;
  project: string;
  cwd: string;
  state: SessionState;
  updated: string; // ISO-8601, UTC
  /**
   * Text of the most recent assistant reply. Kept as messages[0]; retained as
   * its own field so an older installed client still shows something.
   */
  message?: string;
  /**
   * Recent replies, NEWEST FIRST, so you can scroll back through what was said
   * earlier rather than only seeing the last turn. Reconstructed from the
   * transcript by the hook (a tool call splits a turn into several assistant
   * messages, so the raw `last_assistant_message` is only its final paragraph).
   * Depth is capped in the hook - this file is re-read once a second, so it is
   * not allowed to grow without bound.
   */
  messages?: string[];
  /**
   * Claude Code's own "away summary" for the turn shown in `message`.
   *
   * Claude writes one about three minutes after a turn ends, but ONLY while
   * the terminal is unfocused - its internal prompt is literally "the user
   * stepped away and is coming back", and it asks for under 40 words, plain
   * sentences, no markdown. That is written for someone walking back to a
   * screen, which is exactly what this device is, so it makes a far better
   * headline than the opening paragraph of a long reply.
   *
   * Absent most of the time. It needs three user turns in the session, two
   * since the last recap, an empty input box and no pending background work,
   * so it lands on roughly a fifth of turns (measured: 391 of 2001). Treat it
   * as a bonus on top of the reply, never as what the screen depends on.
   */
  recap?: string;
  /** ISO-8601 timestamp of that recap. Only sent when newer than `updated`. */
  recapAt?: string;
  /**
   * Where this session's transcript lives, published by the hook so the server
   * can tail it for the recap. No hook fires when a recap is written, so
   * watching the file is the only way to see one. The client has no use for it.
   */
  transcript?: string;
  /**
   * When this session was last marked READ on the device, ISO-8601.
   *
   * Purely the device's own opinion - nothing is written back to Claude Code,
   * and the terminal session neither knows nor cares. A finished session counts
   * as read only while `readAt >= updated`, so the next turn it finishes makes
   * it unread again on its own, with no state to clear.
   */
  readAt?: string;
};

export type StatusPayload = {
  sessions: ClaudeSession[];
  /** ISO timestamp of the last successful read of the state file. */
  updated: string;
  /** Set when the state file could not be read, so the screen can say why. */
  error?: string;
};

/** Message types the SERVER sends to the CLIENT. */
export enum SERVER_TYPE {
  STATUS = "claudeStatus",
}

/** Message types the CLIENT sends to the SERVER. */
export enum CLIENT_TYPE {
  STATUS = "claudeStatusRequest",
  MARK_READ = "claudeStatusMarkRead",
}

export type ToClientData = {
  type: SERVER_TYPE.STATUS;
  request: "update";
  payload: StatusPayload;
};

export type ToServerData =
  | {
      type: CLIENT_TYPE.STATUS;
      request: "get";
      payload: undefined;
      clientId?: string;
    }
  | {
      type: CLIENT_TYPE.MARK_READ;
      request: "set";
      /** `at` is the session's `updated` at the moment it was read, not the
       *  wall clock, so a turn that lands while you are looking at the screen
       *  is not silently marked read along with the one you actually saw. */
      payload: { id: string; at: string };
      clientId?: string;
    };

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
   * Text of the last assistant reply, captured from the Stop hook's
   * `last_assistant_message`. Truncated by the hook; may be absent for a
   * session that has not finished a turn yet.
   */
  message?: string;
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
}

export type ToClientData = {
  type: SERVER_TYPE.STATUS;
  request: "update";
  payload: StatusPayload;
};

export type ToServerData = {
  type: CLIENT_TYPE.STATUS;
  request: "get";
  payload: undefined;
  clientId?: string;
};

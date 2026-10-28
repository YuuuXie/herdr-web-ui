import { ConnectionDiagnostics } from "./connection-diagnostics.ts";
import { COPILOT_UNAVAILABLE_REASONS, ConversationReadPending, ConversationUnavailable } from "./conversation-shared.ts";

const REASONS = [
  ...COPILOT_UNAVAILABLE_REASONS, "branch_unreadable", "transcript_missing", "no_session_path",
  "no_session_id", "no_recognized_transcript", "pane_not_found", "session_not_written", "copilot_resume_unknown",
];
const INTERVAL_MS = 30_000;
const MAX_LINES = 16;

/** Keys stay private; only fixed reasons and server-generated request IDs leave the process. */
export class ConversationDiagnostics {
  private readonly episodes: ConnectionDiagnostics;
  private windowAt = -Infinity;
  private lines = 0;

  constructor(write: (line: string) => void = (line) => console.warn(line), private now: () => number = () => performance.now()) {
    this.episodes = new ConnectionDiagnostics("conversation", (line) => {
      this.lines++;
      write(line);
    }, () => performance.timeOrigin + now());
  }

  private available(): boolean {
    const at = this.now();
    if (at - this.windowAt >= INTERVAL_MS) { this.windowAt = at; this.lines = 0; }
    return this.lines < MAX_LINES;
  }

  unavailable(key: string, error: ConversationUnavailable | ConversationReadPending, requestId?: string): void {
    if (!this.available()) return;
    const pending = error instanceof ConversationReadPending;
    const reason = pending ? "read_pending" : REASONS.find((reason) => reason === (error.diagnostic ?? error.message)) ?? "unknown";
    this.episodes.failed(key, pending ? "conversation_read_pending" : "conversation_unavailable", {
      operation: `conversation.${reason}`, request_id: requestId,
    });
  }

  recovered(key: string, requestId?: string): void {
    if (!this.available()) return;
    this.episodes.recovered(key, { operation: "conversation", request_id: requestId });
  }
}

/**
 * DSH Completion Reminder — server-side entry.
 *
 * The node half is a stub for host-profile compatibility: a DSH profile
 * bundle that declares `dsh.bundle.patch` needs an `apply`. The actual
 * delivery logic lives in the client half (`src/client.ts`).
 */

import type { CompletionReminderOptions } from './types.js';

/**
 * Host-side apply (stub). The client half (`./client.js`) drives the
 * browser-side behaviour and the actual notification delivery.
 */
export function apply(ctx: any, _config?: CompletionReminderOptions): void {
  // Host-side: no runtime behaviour needed; the browser half owns the UI.
}

export type { CompletionReminderOptions } from './types.js';

// SelectedAccount is the shape returned by the 3-layer scheduler (scheduler.ts)
// and consumed by failoverLoop, withSlotAndCredential, and routes/messages.
// The former selectAccounts() query was deleted (dead code, superseded by the
// scheduler, and unguarded for BYOK ownership).

export interface SelectedAccount {
  id: string;
  concurrency: number;
}

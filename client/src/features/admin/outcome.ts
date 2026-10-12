// What a dialog is told when the view has finished the call it asked for. The view makes the call
// and decides what a success changes (lists, announcement, which dialog is open); the dialog only
// needs to know whether to show a refusal.
export type Outcome = { readonly ok: true } | { readonly ok: false; readonly message: string };

export const DONE: Outcome = { ok: true };

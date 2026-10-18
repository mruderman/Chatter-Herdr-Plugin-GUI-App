// Words that two layers must say the same way, kept where both can import them: the shell's Connection
// status and the store's answer to a send in a revoked session. Plain data, no imports, so that the shell
// stays free of the API module and the store (features/shell/types.ts) and the store stays free of the shell.

/** The state of a member whose access the bridge ended. */
export const ACCESS_REVOKED = 'Access revoked';

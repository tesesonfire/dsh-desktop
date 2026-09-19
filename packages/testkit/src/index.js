/**
 * Shared fixtures for cross-package tests (S8 slot). The executable mock is
 * packages/testkit/bin/mock-dsh.mjs; this module only carries constants.
 */

/** A ready line with a known port/token for deterministic parser tests. */
export const READY_LINE_FIXTURE = 'dsh web: http://127.0.0.1:45621/?token=fixture-token_0123456789abcdef';

/** Same, with the LAN suffix the official CLI appends on non-loopback binds. */
export const READY_LINE_LAN_FIXTURE =
  'dsh web: http://127.0.0.1:45621/?token=fixture-token_0123456789abcdef (LAN: http://192.168.1.4:45621/?token=fixture-token_0123456789abcdef)';

/** Marker argv shape the shells build for the dsh CLI. */
export const DSH_ARGS_FIXTURE = ['--profile', 'dsh-desktop-electron', '--patch', 'cordis.patch.yml', '--port', '0', '--no-open'] as const;

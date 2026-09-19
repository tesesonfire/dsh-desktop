#!/usr/bin/env node
// Test fixture: a DSH_BIN stand-in that exits with an error before any ready
// line — used to prove spawn failures land in the sidecar state machine.
process.stderr.write('boom: deliberate fixture failure\n');
process.exit(3);

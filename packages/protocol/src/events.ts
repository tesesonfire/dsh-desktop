/** Event channel names from the platform shell to the renderer. */
export const BRIDGE_EVENTS = {
  state: 'dsh:state',
  log: 'dsh:log',
} as const;

export type BridgeEventName = (typeof BRIDGE_EVENTS)[keyof typeof BRIDGE_EVENTS];

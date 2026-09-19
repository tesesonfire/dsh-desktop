import { describe, expect, it } from 'vitest';
import { CONTROL_ENDPOINTS, DESKTOP_BRIDGE_METHODS, isSameOrigin, parseReadyLine } from '../src/index.js';

describe('parseReadyLine', () => {
  it('parses the official ready line', () => {
    expect(parseReadyLine('dsh web: http://127.0.0.1:3080/?token=abcDEF-_123')).toEqual({
      url: 'http://127.0.0.1:3080/?token=abcDEF-_123',
      origin: 'http://127.0.0.1:3080',
      port: 3080,
    });
  });

  it('parses a random port and strips the LAN suffix', () => {
    const info = parseReadyLine(
      'dsh web: http://127.0.0.1:49152/?token=x_y-z9 (LAN: http://192.168.1.4:49152/?token=x_y-z9)',
    );
    expect(info).not.toBeNull();
    expect(info?.port).toBe(49152);
    expect(info?.url).toBe('http://127.0.0.1:49152/?token=x_y-z9');
  });

  it('rejects non-ready lines and malformed ports', () => {
    expect(parseReadyLine('dsh web: opening the default browser')).toBeNull();
    expect(parseReadyLine('listening on port 3080')).toBeNull();
    expect(parseReadyLine('dsh web: http://127.0.0.1:0/?token=abc')).toBeNull();
    expect(parseReadyLine('dsh web: http://127.0.0.1:70000/?token=abc')).toBeNull();
    // token must not be stripped — it is the credential
    expect(parseReadyLine('dsh web: http://127.0.0.1:3080/')).toBeNull();
    expect(parseReadyLine('dsh web: https://127.0.0.1:3080/?token=abc')).toBeNull();
  });

  it('isSameOrigin does origin equality, not prefix matching', () => {
    expect(isSameOrigin('http://127.0.0.1:3080/?token=x', 'http://127.0.0.1:3080')).toBe(true);
    expect(isSameOrigin('http://127.0.0.1:3081/?token=x', 'http://127.0.0.1:3080')).toBe(false);
    expect(isSameOrigin('http://127.0.0.1:3080/evil', 'http://127.0.0.1:3080')).toBe(true);
    expect(isSameOrigin('not a url', 'http://127.0.0.1:3080')).toBe(false);
  });

  it('control endpoints are stable strings', () => {
    expect(CONTROL_ENDPOINTS.hello).toBe('/v0/hello');
    expect(CONTROL_ENDPOINTS.webviewAttach).toBe('/v0/webview/attach');
    expect(CONTROL_ENDPOINTS.hostStop).toBe('/v0/host/stop');
    expect(CONTROL_ENDPOINTS.hostRestart).toBe('/v0/host/restart');
    expect(CONTROL_ENDPOINTS.events).toBe('/v0/events');
  });

  it('desktop bridge method list is exactly the interface keys', () => {
    // compile-time assertions live in bridge.ts; this mirrors the count (v1.1 = 18)
    expect(DESKTOP_BRIDGE_METHODS).toHaveLength(18);
  });
});

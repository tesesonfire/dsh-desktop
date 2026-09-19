import { describe, expect, it } from 'vitest';
import { navigationAllowed } from '../src/main/shell';

const READY = 'http://127.0.0.1:45123';
const DEV = 'http://localhost:1420';

describe('navigationAllowed (shell fence)', () => {
  it('after ready: only the ready origin passes — file: is DENIED', () => {
    expect(navigationAllowed(`${READY}/?token=x`, READY)).toBe(true);
    expect(navigationAllowed(`${READY}/`, READY)).toBe(true);
    // regression: file: used to stay allowed after ready
    expect(navigationAllowed('file:///C:/Windows/system32/evil.html', READY)).toBe(false);
    expect(navigationAllowed('http://127.0.0.1:45124/?token=x', READY)).toBe(false);
    expect(navigationAllowed('https://127.0.0.1:45123/?token=x', READY)).toBe(false);
  });

  it('before ready: local renderer surfaces pass, remote origins do not', () => {
    expect(navigationAllowed('file:///D:/repo/dist/renderer/index.html#settings', null)).toBe(true);
    expect(navigationAllowed(`${DEV}/src/main.tsx`, null, DEV)).toBe(true);
    expect(navigationAllowed('http://evil.example/', null, DEV)).toBe(false);
    expect(navigationAllowed('not a url', null, DEV)).toBe(false);
  });

  it('origin equality, never prefix matching', () => {
    expect(navigationAllowed('http://127.0.0.145123.evil.example/', READY)).toBe(false);
    expect(navigationAllowed('http://127.0.0.145123.evil.example/', null, 'http://127.0.0.145123.evil.example')).toBe(true);
  });
});

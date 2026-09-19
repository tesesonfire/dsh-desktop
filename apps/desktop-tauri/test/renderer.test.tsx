import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { createElement } from 'react';
import { DesktopRoot } from '@dsh-desktop/ui';
import { makeFakeBridge } from '../../packages/ui/test/helpers.js';

describe('desktop-tauri renderer', () => {
  it('mounts DesktopRoot markup (shared with the Electron renderer)', () => {
    const html = renderToString(createElement(DesktopRoot, { bridge: makeFakeBridge() }));
    expect(html).toContain('dsh-');
  });
});

import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesktopRoot } from '../src/DesktopRoot.js';
import { makeFakeBridge } from './helpers.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DesktopRoot', () => {
  it('renders the hand-off note in the running state', () => {
    const html = renderToString(
      <DesktopRoot
        bridge={makeFakeBridge()}
        initialStatus={{ state: 'running', port: 49152, url: 'http://127.0.0.1:49152/?token=x' }}
      />,
    );
    expect(html).toContain('界面即将加载');
    expect(html).not.toContain('dsh-spinner');
  });

  it('renders the ErrorPanel title in the error state', () => {
    const html = renderToString(
      <DesktopRoot
        bridge={makeFakeBridge()}
        initialStatus={{ state: 'error', error: 'host crashed' }}
      />,
    );
    expect(html).toContain('启动失败');
    expect(html).toContain('host crashed');
  });

  it('renders the startup stage list before the first status lands', () => {
    const html = renderToString(<DesktopRoot bridge={makeFakeBridge()} />);
    expect(html).toContain('解析 Profile');
    expect(html).toContain('dsh-spinner');
  });

  it('renders SettingsView for location.hash === #settings', () => {
    vi.stubGlobal('location', { hash: '#settings', search: '' });
    const html = renderToString(<DesktopRoot bridge={makeFakeBridge()} />);
    expect(html).toContain('dsh-settings');
    expect(html).toContain('设置');
    expect(html).not.toContain('dsh-startup');
  });

  it('renders SettingsView for search containing view=settings', () => {
    vi.stubGlobal('location', { hash: '', search: '?view=settings' });
    const html = renderToString(<DesktopRoot bridge={makeFakeBridge()} />);
    expect(html).toContain('dsh-settings');
    expect(html).not.toContain('dsh-startup');
  });

  it('renders the fallback error card when no bridge is detectable', () => {
    // No window stub and no props: getDesktopBridge() throws internally and
    // DesktopRoot must degrade to an error panel instead of crashing.
    const html = renderToString(<DesktopRoot />);
    expect(html).toContain('无法连接桌面壳');
    expect(html).not.toContain('dsh-spinner');
  });
});

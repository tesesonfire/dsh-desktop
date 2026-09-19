import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DesktopSettings, InstalledPlugin } from '@dsh-desktop/protocol';
import { ErrorPanel } from '../src/components/ErrorPanel.js';
import { SettingsView } from '../src/components/SettingsView.js';
import { StartupProgress } from '../src/components/StartupProgress.js';
import { makeFakeBridge } from './helpers.js';

describe('StartupProgress', () => {
  it('renders the three stages and the start button when stopped', () => {
    const html = renderToString(
      <StartupProgress bridge={makeFakeBridge()} status={{ state: 'stopped' }} logs={[]} />,
    );
    expect(html).toContain('解析 Profile');
    expect(html).toContain('启动 DSH Host');
    expect(html).toContain('Web carrier 就绪');
    expect(html).toContain('启动 Host');
    expect(html).toContain('dsh-stage--pending');
    expect(html).not.toContain('dsh-spinner');
  });

  it('shows the active spinner stage and the log tail while starting', () => {
    const html = renderToString(
      <StartupProgress
        bridge={null}
        status={{ state: 'starting' }}
        logs={['boot line 1', 'dsh web: http://127.0.0.1:49152/?token=abc']}
      />,
    );
    expect(html).toContain('dsh-stage--active');
    expect(html).toContain('dsh-spinner');
    expect(html).toContain('dsh-stage--done');
    expect(html).toContain('dsh web: http://127.0.0.1:49152/?token=abc');
  });

  it('shows all stages done plus the hand-off note when running', () => {
    const html = renderToString(
      <StartupProgress
        bridge={null}
        status={{
          state: 'running',
          port: 49152,
          url: 'http://127.0.0.1:49152/?token=abc',
        }}
        logs={[]}
      />,
    );
    expect(html).toContain('界面即将加载');
    expect(html).toContain('dsh-stage--done');
    expect(html).toContain('http://127.0.0.1:49152/?token=abc');
    expect(html).not.toContain('dsh-spinner');
    expect(html).not.toContain('启动 Host');
  });

  it('renders the ErrorPanel with error text and recent logs on failure', () => {
    const html = renderToString(
      <StartupProgress
        bridge={null}
        status={{ state: 'error', error: 'spawn dsh failed: ENOENT' }}
        logs={['line-a', 'line-b']}
      />,
    );
    expect(html).toContain('启动失败');
    expect(html).toContain('spawn dsh failed: ENOENT');
    expect(html).toContain('line-a');
    expect(html).toContain('line-b');
    expect(html).toContain('dsh-stage--error');
  });
});

describe('ErrorPanel', () => {
  it('renders title, message and optional hint', () => {
    const html = renderToString(
      <ErrorPanel title="Big trouble" message="detail line" hint="try again" />,
    );
    expect(html).toContain('Big trouble');
    expect(html).toContain('detail line');
    expect(html).toContain('try again');

    const noHint = renderToString(<ErrorPanel title="T" message="M" />);
    expect(noHint).not.toContain('Hint');
  });
});

describe('SettingsView', () => {
  it('renders the bilingual heading and the loading state before promises resolve', () => {
    // renderToString captures the pre-promise render: the action buttons and
    // profile list only appear once the load effect has run (client-side).
    const html = renderToString(<SettingsView bridge={makeFakeBridge()} />);
    expect(html).toContain('dsh-settings');
    expect(html).toContain('设置');
    expect(html).toContain('Settings');
    expect(html).toContain('加载中');
  });

  it('does not render any profile row before profile_list resolves', () => {
    const html = renderToString(<SettingsView bridge={makeFakeBridge()} />);
    expect(html).not.toContain('dsh-list-btn');
  });

  it('renders the three section headings on one page', () => {
    const html = renderToString(<SettingsView bridge={makeFakeBridge()} />);
    expect(html).toContain('配置档案');
    expect(html).toContain('外观与行为');
    expect(html).toContain('插件与诊断');
  });

  it('seeds switches and the zoom display from the injected settings', () => {
    const settings: DesktopSettings = {
      closeToTray: true,
      startMinimized: false,
      zoomFactor: 1,
    };
    const html = renderToString(
      <SettingsView bridge={makeFakeBridge()} initialSettings={settings} />,
    );
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('aria-checked="false"');
    // SSR emits checked="" only for the true toggle; aria-checked is the
    // discriminating attribute for both.
    expect(html).toContain('100%');
    expect(html).toContain('min="0.5"');
    expect(html).toContain('max="2"');
    expect(html).toContain('step="0.1"');
    // No save happened, so no save confirmation yet.
    expect(html).not.toContain('已保存');
  });

  it('shows 150% with both switches off for zoomFactor 1.5', () => {
    const settings: DesktopSettings = {
      closeToTray: false,
      startMinimized: false,
      zoomFactor: 1.5,
    };
    const html = renderToString(
      <SettingsView bridge={makeFakeBridge()} initialSettings={settings} />,
    );
    expect(html).toContain('150%');
    expect(html).not.toContain('aria-checked="true"');
  });

  it('renders injected plugin rows with name, version and patch path', () => {
    const plugins: InstalledPlugin[] = [
      { name: 'dsh-web-app', version: '0.1.2', patchPath: 'patches/web.patch' },
      { name: 'dsh-desktop-shell', version: '0.2.0' },
    ];
    const html = renderToString(
      <SettingsView bridge={makeFakeBridge()} initialPlugins={plugins} />,
    );
    expect(html).toContain('dsh-web-app');
    expect(html).toContain('v0.1.2');
    expect(html).toContain('patches/web.patch');
    expect(html).toContain('dsh-desktop-shell');
    expect(html).toContain('v0.2.0');
    expect(html).toContain('重新扫描');
    expect(html).toContain('导出诊断');
  });

  it('omits the patch path for plugins that declare none', () => {
    const plugins: InstalledPlugin[] = [{ name: 'dsh-web-app', version: '0.1.2' }];
    const html = renderToString(
      <SettingsView bridge={makeFakeBridge()} initialPlugins={plugins} />,
    );
    expect(html).toContain('dsh-web-app');
    expect(html).not.toContain('dsh-plugin-patch');
  });
});

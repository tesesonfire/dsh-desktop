import { useCallback, useEffect, useState } from 'react';
import type {
  DesktopBridge,
  DesktopSettings,
  InstalledPlugin,
  Profile,
} from '@dsh-desktop/protocol';
import { bridgeErrorMessage } from '../bridge.js';
import { usePluginList, useShellSettings } from '../hooks.js';
import { ErrorPanel } from './ErrorPanel.js';

export interface SettingsViewProps {
  bridge: DesktopBridge;
  /**
   * SSR/embed seam — settings shown on the very first render, before the
   * mount-time settings_get() resolves. The live shell omits it and re-reads
   * on mount; only tests and static embedding pass real values here.
   */
  initialSettings?: DesktopSettings;
  /** SSR/embed seam — plugin inventory shown before the first plugin_list(). */
  initialPlugins?: InstalledPlugin[];
}

/**
 * Settings panel, three sections on one page (no router):
 *  1. Profiles      — existing profile management + window/data actions.
 *  2. Appearance    — v1.1 shell preferences (settings_get/settings_set).
 *  3. Plugins/diag  — v1.1 plugin inventory + diagnostics export.
 * Each section owns its loading/error state; a failure in one never blanks
 * the others.
 */
export function SettingsView({ bridge, initialSettings, initialPlugins }: SettingsViewProps) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [current, setCurrent] = useState<Profile | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyName, setBusyName] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [list, currentProfile, appVersion] = await Promise.all([
        bridge.profile_list(),
        bridge.profile_current(),
        bridge.get_app_version(),
      ]);
      setProfiles(list);
      setCurrent(currentProfile);
      setVersion(appVersion);
    } catch (err: unknown) {
      setError(bridgeErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [bridge]);

  useEffect(() => {
    void load();
  }, [load]);

  const onSwitch = useCallback(
    async (name: string) => {
      setBusyName(name);
      setError(null);
      try {
        await bridge.profile_switch(name);
        setCurrent(await bridge.profile_current());
      } catch (err: unknown) {
        setError(bridgeErrorMessage(err));
      } finally {
        setBusyName(null);
      }
    },
    [bridge],
  );

  const onOpenDataDir = useCallback(() => {
    void bridge.open_data_dir().catch((err: unknown) => {
      setError(bridgeErrorMessage(err));
    });
  }, [bridge]);

  const onShowWindow = useCallback(() => {
    void bridge.window_show().catch((err: unknown) => {
      setError(bridgeErrorMessage(err));
    });
  }, [bridge]);

  return (
    <div className="dsh-card dsh-settings">
      <h1 className="dsh-title">
        设置
        <span className="dsh-en">Settings</span>
      </h1>

      {error ? <ErrorPanel title="操作失败 / Action failed" message={error} /> : null}

      <section className="dsh-section">
        <h2 className="dsh-subtitle">
          配置档案 <span className="dsh-en">Profiles</span>
        </h2>
        {loading ? (
          <p className="dsh-note">
            加载中… <span className="dsh-en">Loading…</span>
          </p>
        ) : profiles.length === 0 ? (
          <p className="dsh-note">
            未找到配置档案 <span className="dsh-en">No profiles found</span>
          </p>
        ) : (
          <ul className="dsh-list">
            {profiles.map((profile) => {
              const isCurrent = current?.name === profile.name;
              const classes = ['dsh-list-btn', isCurrent ? 'dsh-list-btn--current' : '']
                .filter(Boolean)
                .join(' ');
              return (
                <li key={profile.name}>
                  <button
                    type="button"
                    className={classes}
                    disabled={busyName != null}
                    onClick={() => void onSwitch(profile.name)}
                  >
                    <span className="dsh-list-name">{profile.name}</span>
                    {isCurrent ? <span className="dsh-badge">当前 / current</span> : null}
                    {busyName === profile.name ? (
                      <span className="dsh-spinner" aria-hidden="true" />
                    ) : null}
                    <span className="dsh-list-path" title={profile.path}>
                      {profile.path}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {loading ? null : (
        <section className="dsh-actions">
          <button type="button" className="dsh-btn" onClick={onOpenDataDir}>
            打开数据目录
            <span className="dsh-btn-en">Open data folder</span>
          </button>
          <button type="button" className="dsh-btn" onClick={onShowWindow}>
            显示主窗口
            <span className="dsh-btn-en">Show main window</span>
          </button>
        </section>
      )}

      <AppearanceSection bridge={bridge} initialSettings={initialSettings} />
      <PluginsSection bridge={bridge} initialPlugins={initialPlugins} />

      {version ? <footer className="dsh-footer">DSH Desktop v{version}</footer> : null}
    </div>
  );
}

interface SectionProps {
  bridge: DesktopBridge;
}

/**
 * Section 2 — shell preferences. Every control is controlled and disabled
 * while a save is in flight; the platform shell is the source of truth, so
 * the UI adopts the value returned by settings_set (which validates, applies
 * and persists) rather than merging the patch locally.
 */
function AppearanceSection({ bridge, initialSettings }: SectionProps & { initialSettings?: DesktopSettings }) {
  const { settings, loading, saving, error, lastSave, update } = useShellSettings(
    bridge,
    initialSettings,
  );

  return (
    <section className="dsh-section">
      <h2 className="dsh-subtitle">
        外观与行为 <span className="dsh-en">Appearance &amp; Behavior</span>
      </h2>

      {settings == null ? (
        <p className="dsh-note">
          {error != null ? (
            error
          ) : loading ? (
            <>
              加载中… <span className="dsh-en">Loading…</span>
            </>
          ) : (
            <>
              设置不可用 <span className="dsh-en">Settings unavailable</span>
            </>
          )}
        </p>
      ) : (
        <>
          <label className="dsh-row">
            <span className="dsh-row-label">
              关闭窗口时最小化到托盘 <span className="dsh-en">Close to tray</span>
            </span>
            <input
              type="checkbox"
              role="switch"
              className="dsh-switch"
              aria-checked={settings.closeToTray}
              checked={settings.closeToTray}
              disabled={saving}
              onChange={(e) => void update({ closeToTray: e.target.checked })}
            />
          </label>

          <label className="dsh-row">
            <span className="dsh-row-label">
              启动时最小化到托盘 <span className="dsh-en">Start minimized</span>
            </span>
            <input
              type="checkbox"
              role="switch"
              className="dsh-switch"
              aria-checked={settings.startMinimized}
              checked={settings.startMinimized}
              disabled={saving}
              onChange={(e) => void update({ startMinimized: e.target.checked })}
            />
          </label>

          <div className="dsh-row">
            <label className="dsh-row-label" htmlFor="dsh-zoom">
              界面缩放 <span className="dsh-en">Zoom factor</span>
            </label>
            <span className="dsh-slider-group">
              <input
                id="dsh-zoom"
                type="range"
                className="dsh-slider"
                min={0.5}
                max={2}
                step={0.1}
                value={settings.zoomFactor}
                disabled={saving}
                aria-label="界面缩放 / Zoom factor"
                onChange={(e) => void update({ zoomFactor: Number(e.target.value) })}
              />
              {/* Single template expression: adjacent text nodes would make
                  React SSR inject comment separators (100<!-- -->%). */}
              <span className="dsh-slider-value">{`${Math.round(settings.zoomFactor * 100)}%`}</span>
            </span>
          </div>

          {saving ? (
            <p className="dsh-note" role="status">
              保存中… <span className="dsh-en">Saving…</span>
            </p>
          ) : lastSave === 'ok' ? (
            <p className="dsh-note dsh-note--ok" role="status">
              已保存 <span className="dsh-en">Saved</span>
            </p>
          ) : null}
          {error != null ? (
            <p className="dsh-error-inline" role="alert">
              {error}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

/**
 * Section 3 — plugin inventory + diagnostics export. Rescan re-runs
 * plugin_list(); diagnostics_export returns the archive path, which is shown
 * verbatim on success.
 */
function PluginsSection({ bridge, initialPlugins }: SectionProps & { initialPlugins?: InstalledPlugin[] }) {
  const { plugins, loading, rescanning, error, rescan } = usePluginList(bridge, initialPlugins);
  const [diagBusy, setDiagBusy] = useState(false);
  const [diagPath, setDiagPath] = useState<string | null>(null);
  const [diagError, setDiagError] = useState<string | null>(null);

  const onExport = useCallback(async () => {
    setDiagBusy(true);
    setDiagError(null);
    setDiagPath(null);
    try {
      const result = await bridge.diagnostics_export();
      setDiagPath(result.path);
    } catch (err: unknown) {
      setDiagError(bridgeErrorMessage(err));
    } finally {
      setDiagBusy(false);
    }
  }, [bridge]);

  return (
    <section className="dsh-section">
      <h2 className="dsh-subtitle">
        插件与诊断 <span className="dsh-en">Plugins &amp; Diagnostics</span>
      </h2>

      {plugins.length === 0 ? (
        <p className="dsh-note">
          {loading ? (
            <>
              加载中… <span className="dsh-en">Loading…</span>
            </>
          ) : (
            <>
              未发现已安装插件 <span className="dsh-en">No plugins installed</span>
            </>
          )}
        </p>
      ) : (
        <ul className="dsh-plugin-list">
          {plugins.map((plugin) => (
            <li key={plugin.name} className="dsh-plugin-row">
              <span className="dsh-plugin-name">{plugin.name}</span>
              <span className="dsh-badge dsh-badge--dim">{`v${plugin.version}`}</span>
              {plugin.patchPath ? (
                <span className="dsh-plugin-patch" title={plugin.patchPath}>
                  {plugin.patchPath}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <div className="dsh-actions">
        <button
          type="button"
          className="dsh-btn"
          disabled={loading || rescanning}
          onClick={() => void rescan()}
        >
          {rescanning ? '重新扫描中…' : '重新扫描'}
          <span className="dsh-btn-en">Rescan</span>
        </button>
        <button type="button" className="dsh-btn" disabled={diagBusy} onClick={() => void onExport()}>
          导出诊断
          <span className="dsh-btn-en">Export diagnostics</span>
        </button>
        {rescanning || diagBusy ? <span className="dsh-spinner" aria-hidden="true" /> : null}
      </div>

      {diagPath != null ? (
        <p className="dsh-note dsh-note--ok" role="status">
          诊断包已导出 <span className="dsh-en">Diagnostics exported</span>：
          <span className="dsh-path-inline">{diagPath}</span>
        </p>
      ) : null}
      {error != null ? (
        <p className="dsh-error-inline" role="alert">
          {error}
        </p>
      ) : null}
      {diagError != null ? (
        <p className="dsh-error-inline" role="alert">
          {diagError}
        </p>
      ) : null}
    </section>
  );
}

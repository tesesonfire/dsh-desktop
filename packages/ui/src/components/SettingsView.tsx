import { useCallback, useEffect, useState } from 'react';
import type { DesktopBridge, Profile } from '@dsh-desktop/protocol';
import { bridgeErrorMessage } from '../bridge.js';
import { ErrorPanel } from './ErrorPanel.js';

export interface SettingsViewProps {
  bridge: DesktopBridge;
}

/**
 * Profile management panel. Loads profiles + current profile + app version on
 * mount; switching profiles goes through the shell (profile_switch) and then
 * re-reads profile_current so the UI never guesses the new state.
 */
export function SettingsView({ bridge }: SettingsViewProps) {
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

      {loading ? (
        <p className="dsh-note">
          加载中… <span className="dsh-en">Loading…</span>
        </p>
      ) : (
        <>
          <section>
            <h2 className="dsh-subtitle">
              配置档案 <span className="dsh-en">Profiles</span>
            </h2>
            {profiles.length === 0 ? (
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

          {version ? <footer className="dsh-footer">DSH Desktop v{version}</footer> : null}
        </>
      )}
    </div>
  );
}

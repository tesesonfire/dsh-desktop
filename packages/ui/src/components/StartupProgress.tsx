import { useCallback } from 'react';
import type { DesktopBridge, HostState, HostStatus } from '@dsh-desktop/protocol';
import { ErrorPanel } from './ErrorPanel.js';

export interface StartupProgressProps {
  /**
   * Needed only for the "start host" action; null renders the button disabled
   * (e.g. when no platform shell was detected).
   */
  bridge: DesktopBridge | null;
  status: HostStatus;
  logs: string[];
}

type StageState = 'pending' | 'active' | 'done' | 'error';

const STAGES: ReadonlyArray<{ zh: string; en: string }> = [
  { zh: '解析 Profile', en: 'Resolve profile' },
  { zh: '启动 DSH Host', en: 'Start DSH host' },
  { zh: 'Web carrier 就绪', en: 'Web carrier ready' },
];

/**
 * Bridge contract carries no sub-step granularity, so each top state maps to a
 * fixed stage picture. While `starting`, the profile is already resolved (the
 * shell spawns `dsh --profile <p>`), hence stage 1 is shown as done.
 */
function stageStates(state: HostState): StageState[] {
  switch (state) {
    case 'stopped':
      return ['pending', 'pending', 'pending'];
    case 'starting':
      return ['done', 'active', 'pending'];
    case 'running':
      return ['done', 'done', 'done'];
    case 'error':
      return ['done', 'error', 'pending'];
  }
}

const LOG_TAIL = 8;

export function StartupProgress({ bridge, status, logs }: StartupProgressProps) {
  const stages = stageStates(status.state);
  const recentLogs = logs.slice(-LOG_TAIL);

  const onStart = useCallback(() => {
    if (bridge == null) return;
    // Fire-and-forget: the shell pushes the authoritative transition (including
    // the failure path) over dsh:state, so a rejection is only logged locally.
    void bridge.host_start().catch((err: unknown) => {
      console.error('[dsh-ui] host_start rejected:', err);
    });
  }, [bridge]);

  return (
    <div className="dsh-card dsh-startup">
      <h1 className="dsh-title">DSH Desktop</h1>
      <p className="dsh-subtitle">正在连接 DeepSeek Harness 运行时 / Connecting to the DeepSeek Harness runtime</p>

      <ol className="dsh-stages">
        {STAGES.map((stage, index) => {
          const stageState = stages[index] ?? 'pending';
          const classes = ['dsh-stage', `dsh-stage--${stageState}`].join(' ');
          return (
            <li key={stage.en} className={classes}>
              <span className="dsh-stage__dot">
                {stageState === 'active' ? <span className="dsh-spinner" aria-hidden="true" /> : null}
              </span>
              <span className="dsh-stage__label">
                {stage.zh}
                <span className="dsh-en">{stage.en}</span>
              </span>
            </li>
          );
        })}
      </ol>

      {status.state === 'stopped' ? (
        <div className="dsh-actions">
          <button
            type="button"
            className="dsh-btn dsh-btn--primary"
            onClick={onStart}
            disabled={bridge == null}
          >
            启动 Host
            <span className="dsh-btn-en">Start host</span>
          </button>
          <span className="dsh-note">等待启动 / Waiting to start</span>
        </div>
      ) : null}

      {status.state === 'starting' ? (
        <p className="dsh-note">正在启动 DSH Host… / Starting the DSH host…</p>
      ) : null}

      {status.state === 'running' ? (
        <div className="dsh-running">
          <p className="dsh-note dsh-note--ok">
            界面即将加载 / The interface will load shortly
          </p>
          <p className="dsh-note">
            平台壳即将把整个窗口导航到 DSH Web 界面。
            / The platform shell is about to navigate the whole window to the DSH web UI.
          </p>
          {status.url ? <p className="dsh-url">{status.url}</p> : null}
        </div>
      ) : null}

      {status.state === 'error' ? (
        <ErrorPanel
          title="启动失败 / Failed to start"
          message={status.error ?? '未知错误 / Unknown error'}
          hint="Host 进程未能启动，请检查下方日志。 / The host process failed to start; check the log tail below."
        />
      ) : null}

      {(status.state === 'starting' || status.state === 'error') && recentLogs.length > 0 ? (
        <section className="dsh-logbox">
          <h2 className="dsh-subtitle">最近日志 / Recent logs</h2>
          <pre className="dsh-logs">{recentLogs.join('\n')}</pre>
        </section>
      ) : null}
    </div>
  );
}

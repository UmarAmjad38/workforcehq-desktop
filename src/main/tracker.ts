import { powerMonitor } from 'electron';
import { AgentLocalDB } from './db';
import { getActiveWindow } from './active-window';

export interface TrackerConfig {
  deviceId: string;
  trackIdleAfterSec: number;
  pollIntervalMs: number;
}

/**
 * Records real foreground app/window segments while the employee is clocked in.
 * Each segment = time spent on one app/title until it changes or a flush interval hits.
 */
export class ActivityTracker {
  private db: AgentLocalDB;
  private config: TrackerConfig;
  private isTracking = false;
  private paused = false;
  private timer: NodeJS.Timeout | null = null;
  private segmentStart: Date | null = null;
  private currentApp = 'Unknown';
  private currentTitle = '';
  private lastFlushAt: Date | null = null;
  private readonly maxSegmentSec = 60;

  constructor(db: AgentLocalDB, config: TrackerConfig) {
    this.db = db;
    this.config = config;
  }

  public updateConfig(newConfig: Partial<TrackerConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }

  public start(): void {
    if (this.isTracking) return;
    this.isTracking = true;
    this.paused = false;
    this.segmentStart = new Date();
    this.lastFlushAt = new Date();
    console.log('[ActivityTracker] Started real window tracking for', this.config.deviceId);

    void this.refreshActiveWindow(true);

    this.timer = setInterval(() => {
      void this.poll();
    }, this.config.pollIntervalMs);
  }

  public stop(): void {
    if (!this.isTracking) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.flushSegment(false);
    this.isTracking = false;
    this.paused = false;
    console.log('[ActivityTracker] Stopped tracking');
  }

  /** Pause while on break — no activity rows written. */
  public pause(): void {
    if (!this.isTracking || this.paused) return;
    this.flushSegment(false);
    this.paused = true;
    console.log('[ActivityTracker] Paused (break)');
  }

  public resume(): void {
    if (!this.isTracking || !this.paused) return;
    this.paused = false;
    this.segmentStart = new Date();
    this.lastFlushAt = new Date();
    void this.refreshActiveWindow(true);
    console.log('[ActivityTracker] Resumed after break');
  }

  public isPaused(): boolean {
    return this.paused;
  }

  public getCurrentWindow(): { app: string; title: string } {
    return { app: this.currentApp, title: this.currentTitle };
  }

  private async refreshActiveWindow(force = false): Promise<void> {
    try {
      const win = await getActiveWindow();
      const changed = win.app !== this.currentApp || win.title !== this.currentTitle;
      if (changed && this.segmentStart && !force) {
        this.flushSegment(false);
        this.segmentStart = new Date();
      }
      this.currentApp = win.app;
      this.currentTitle = win.title;
      if (force && !this.segmentStart) this.segmentStart = new Date();
    } catch (err) {
      console.warn('[ActivityTracker] active window read failed', err);
    }
  }

  private async poll(): Promise<void> {
    if (!this.isTracking || this.paused) return;

    const idleTimeSec = powerMonitor.getSystemIdleTime();
    const isIdle = idleTimeSec >= this.config.trackIdleAfterSec;

    if (!isIdle) {
      await this.refreshActiveWindow(false);
    }

    const now = new Date();
    const sinceFlush = this.lastFlushAt
      ? (now.getTime() - this.lastFlushAt.getTime()) / 1000
      : this.maxSegmentSec;

    // Flush periodically so monitoring sees progress even if the window never changes
    if (sinceFlush >= this.maxSegmentSec) {
      this.flushSegment(isIdle, idleTimeSec);
      this.segmentStart = new Date();
      this.lastFlushAt = now;
    }
  }

  private flushSegment(isIdle: boolean, idleTimeSec = 0): void {
    if (!this.segmentStart) return;
    const now = new Date();
    const durationSec = Math.floor((now.getTime() - this.segmentStart.getTime()) / 1000);
    if (durationSec < 1) {
      this.segmentStart = now;
      return;
    }

    const activeApp = isIdle ? 'Idle / Away' : this.currentApp || 'Unknown';
    const windowTitle = isIdle ? 'System Idle' : this.currentTitle || activeApp;

    this.db.addActivity({
      deviceId: this.config.deviceId,
      sessionStart: this.segmentStart.toISOString(),
      sessionEnd: now.toISOString(),
      activeApp,
      windowTitle,
      idleDurationSec: isIdle ? idleTimeSec || durationSec : 0,
      keystrokeCount: 0,
      mouseClickCount: 0,
      isIdle,
    });

    this.segmentStart = now;
    this.lastFlushAt = now;
  }
}

import axios from 'axios';
import { AgentLocalDB } from './db';

export interface SyncConfig {
  apiUrl: string;
  accessToken: string | null;
  syncIntervalMs: number;
  onUnauthorized?: () => Promise<boolean>;
}

export class AgentSyncEngine {
  private db: AgentLocalDB;
  private config: SyncConfig;
  private timer: NodeJS.Timeout | null = null;
  private isSyncing = false;

  constructor(db: AgentLocalDB, config: SyncConfig) {
    this.db = db;
    this.config = config;
  }

  public setToken(token: string | null): void {
    this.config.accessToken = token;
  }

  public updateApiUrl(url: string): void {
    this.config.apiUrl = url;
  }

  public setUnauthorizedHandler(handler: () => Promise<boolean>): void {
    this.config.onUnauthorized = handler;
  }

  public start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.syncNow();
    }, this.config.syncIntervalMs);
    console.log('[AgentSyncEngine] Started sync worker every', this.config.syncIntervalMs, 'ms');
  }

  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    console.log('[AgentSyncEngine] Stopped sync worker');
  }

  public async syncNow(): Promise<{ syncedActivities: number; syncedScreenshots: number }> {
    if (this.isSyncing || !this.config.accessToken) {
      return { syncedActivities: 0, syncedScreenshots: 0 };
    }

    this.isSyncing = true;
    let syncedActivitiesCount = 0;
    let syncedScreenshotsCount = 0;

    try {
      const post = async (path: string, payload: unknown, timeout: number) => {
        const send = () =>
          axios.post(`${this.config.apiUrl}${path}`, payload, {
            headers: {
              Authorization: `Bearer ${this.config.accessToken}`,
              'Content-Type': 'application/json',
            },
            timeout,
          });
        try {
          return await send();
        } catch (err: any) {
          if (err?.response?.status === 401 && this.config.onUnauthorized) {
            const ok = await this.config.onUnauthorized();
            if (ok) return await send();
          }
          throw err;
        }
      };

      const pendingActivities = this.db.getPendingActivities(50);
      if (pendingActivities.length > 0) {
        const payload = {
          activities: pendingActivities.map((act) => ({
            deviceId: act.deviceId,
            sessionStart: act.sessionStart,
            sessionEnd: act.sessionEnd,
            activeApp: act.activeApp,
            windowTitle: act.windowTitle,
            idleDurationSec: act.idleDurationSec,
            keystrokeCount: act.keystrokeCount,
            mouseClickCount: act.mouseClickCount,
            isIdle: act.isIdle,
          })),
        };

        const res = await post('/api/v1/agent/activity/sync', payload, 20000);
        if (res.data && res.data.success) {
          const idsToRemove = pendingActivities.map((act) => act.id);
          this.db.removeActivities(idsToRemove);
          syncedActivitiesCount = idsToRemove.length;
          console.log(
            `[AgentSyncEngine] Successfully synced ${syncedActivitiesCount} activity items`,
          );
        }
      }

      const pendingScreenshots = this.db.getPendingScreenshots(5);
      for (const scr of pendingScreenshots) {
        try {
          const payload = {
            deviceId: scr.deviceId,
            capturedAt: scr.capturedAt,
            base64Image: scr.base64Image,
            thumbnailBase64: scr.thumbnailBase64,
            isBlurred: scr.isBlurred,
            activityId: scr.activityId,
          };
          const res = await post('/api/v1/agent/screenshots/upload', payload, 60000);
          if (res.data && res.data.success) {
            this.db.removeScreenshots([scr.id]);
            syncedScreenshotsCount++;
            console.log('[AgentSyncEngine] Successfully synced screenshot:', scr.id);
          }
        } catch (err: any) {
          console.warn('[AgentSyncEngine] Screenshot upload failed:', err.message || err);
        }
      }
    } catch (err: any) {
      console.warn('[AgentSyncEngine] Sync attempt failed:', err.message || err);
    } finally {
      this.isSyncing = false;
    }

    return {
      syncedActivities: syncedActivitiesCount,
      syncedScreenshots: syncedScreenshotsCount,
    };
  }
}

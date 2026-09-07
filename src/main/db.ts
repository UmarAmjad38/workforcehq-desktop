import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

export interface LocalActivityItem {
  id: string;
  deviceId: string;
  sessionStart: string;
  sessionEnd: string;
  activeApp: string;
  windowTitle: string;
  idleDurationSec: number;
  keystrokeCount: number;
  mouseClickCount: number;
  isIdle: boolean;
  createdAt: string;
}

export interface LocalScreenshotItem {
  id: string;
  deviceId: string;
  capturedAt: string;
  base64Image: string;
  thumbnailBase64?: string;
  isBlurred: boolean;
  activityId?: string;
  createdAt: string;
}

interface LocalStoreSchema {
  activities: LocalActivityItem[];
  screenshots: LocalScreenshotItem[];
}

export class AgentLocalDB {
  private dbPath: string;
  private data: LocalStoreSchema = { activities: [], screenshots: [] };

  constructor() {
    const userDataPath = app ? app.getPath('userData') : process.cwd();
    this.dbPath = path.join(userDataPath, 'workforce_agent_queue.json');
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.dbPath)) {
        const raw = fs.readFileSync(this.dbPath, 'utf-8');
        this.data = JSON.parse(raw);
      } else {
        this.save();
      }
    } catch (err) {
      console.error('[AgentLocalDB] Failed to load local database, resetting', err);
      this.data = { activities: [], screenshots: [] };
      this.save();
    }
  }

  private save(): void {
    try {
      fs.writeFileSync(this.dbPath, JSON.stringify(this.data, null, 2), 'utf-8');
    } catch (err) {
      console.error('[AgentLocalDB] Failed to save local database', err);
    }
  }

  public addActivity(item: Omit<LocalActivityItem, 'id' | 'createdAt'>): void {
    const record: LocalActivityItem = {
      ...item,
      id: `act_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      createdAt: new Date().toISOString(),
    };
    this.data.activities.push(record);
    // Keep queue bounded so offline backlog cannot grow without limit
    const MAX = 500;
    if (this.data.activities.length > MAX) {
      this.data.activities = this.data.activities.slice(-MAX);
    }
    this.save();
  }

  public getPendingActivities(limit = 100): LocalActivityItem[] {
    return this.data.activities.slice(0, limit);
  }

  public removeActivities(ids: string[]): void {
    const set = new Set(ids);
    this.data.activities = this.data.activities.filter((act) => !set.has(act.id));
    this.save();
  }

  public addScreenshot(item: Omit<LocalScreenshotItem, 'id' | 'createdAt'>): void {
    const record: LocalScreenshotItem = {
      ...item,
      id: `scr_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      createdAt: new Date().toISOString(),
    };
    this.data.screenshots.push(record);
    const MAX = 20;
    if (this.data.screenshots.length > MAX) {
      this.data.screenshots = this.data.screenshots.slice(-MAX);
    }
    this.save();
  }

  public getPendingScreenshots(limit = 10): LocalScreenshotItem[] {
    return this.data.screenshots.slice(0, limit);
  }

  public removeScreenshots(ids: string[]): void {
    const set = new Set(ids);
    this.data.screenshots = this.data.screenshots.filter((scr) => !set.has(scr.id));
    this.save();
  }

  public getQueueStats(): { pendingActivities: number; pendingScreenshots: number } {
    return {
      pendingActivities: this.data.activities.length,
      pendingScreenshots: this.data.screenshots.length,
    };
  }
}

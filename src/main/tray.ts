import { Tray, Menu, app, BrowserWindow, nativeImage } from 'electron';

export interface TrayCallbacks {
  onOpenApp: () => void;
  onSyncNow: () => void;
  onToggleTracking: () => void;
}

export class AgentTray {
  private tray: Tray | null = null;
  private isTracking = true;
  private callbacks: TrayCallbacks;

  constructor(callbacks: TrayCallbacks) {
    this.callbacks = callbacks;
  }

  public init(): void {
    const icon = this.createDefaultIcon();
    this.tray = new Tray(icon);
    this.tray.setToolTip('WorkforceHQ Desktop Agent — Active');
    this.updateMenu();
  }

  private createDefaultIcon() {
    // Generate a simple 16x16 icon programmatically if asset file absent
    const canvas = nativeImage.createFromBuffer(
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAiSURBVDhPY2AYBaNgFIBAMw0NDf8ZSAQMDAwMDAwMoxAAAC5VAwN4+T/RAAAAAElFTkSuQmCC',
        'base64',
      ),
    );
    return canvas;
  }

  public updateTrackingStatus(isTracking: boolean): void {
    this.isTracking = isTracking;
    if (this.tray) {
      this.tray.setToolTip(
        `WorkforceHQ Desktop Agent — ${isTracking ? 'Tracking Active' : 'Paused'}`,
      );
      this.updateMenu();
    }
  }

  private updateMenu(): void {
    if (!this.tray) return;

    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'WorkforceHQ Agent',
        enabled: false,
      },
      { type: 'separator' },
      {
        label: this.isTracking ? '🟢 Working (clocked in)' : '🟡 Clocked out',
        enabled: false,
      },
      {
        label: this.isTracking ? 'Clock out' : 'Clock in',
        click: () => this.callbacks.onToggleTracking(),
      },
      { type: 'separator' },
      {
        label: 'Open Agent',
        click: () => this.callbacks.onOpenApp(),
      },
      {
        label: 'Quit',
        click: () => app.quit(),
      },
    ]);

    this.tray.setContextMenu(contextMenu);
  }

  public destroy(): void {
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }
}

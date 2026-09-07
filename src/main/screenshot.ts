import { desktopCapturer, powerMonitor } from 'electron';
import { AgentLocalDB } from './db';

export interface ScreenshotConfig {
  deviceId: string;
  screenshotIntervalSec: number;
  blurScreenshots: boolean;
  pauseOnIdle: boolean;
  trackIdleAfterSec: number;
}

function toJpegDataUrl(image: Electron.NativeImage, maxWidth: number, quality: number): string {
  const size = image.getSize();
  let resized = image;
  if (size.width > maxWidth) {
    const height = Math.max(1, Math.round((size.height / size.width) * maxWidth));
    resized = image.resize({ width: maxWidth, height, quality: 'better' });
  }
  const jpeg = resized.toJPEG(quality);
  return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
}

export class ScreenshotEngine {
  private db: AgentLocalDB;
  private config: ScreenshotConfig;
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(db: AgentLocalDB, config: ScreenshotConfig) {
    this.db = db;
    this.config = config;
  }

  public updateConfig(newConfig: Partial<ScreenshotConfig>): void {
    this.config = { ...this.config, ...newConfig };
    if (this.isRunning) {
      this.restart();
    }
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    const intervalMs = Math.max(180_000, this.config.screenshotIntervalSec * 1000); // min 3 minutes
    void this.capture({ force: true });
    this.timer = setInterval(() => {
      void this.capture();
    }, intervalMs);

    console.log(
      `[ScreenshotEngine] Started screenshot scheduler every ${Math.round(intervalMs / 1000)}s`,
    );
  }

  public stop(): void {
    if (!this.isRunning) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.isRunning = false;
    console.log('[ScreenshotEngine] Stopped screenshot scheduler');
  }

  public restart(): void {
    this.stop();
    this.start();
  }

  public async capture(opts?: { force?: boolean }): Promise<void> {
    try {
      const frame = await this.captureFrame({
        maxWidth: 960,
        quality: 55,
        thumbWidth: 320,
        thumbQuality: 40,
        skipIfIdle: !opts?.force,
      });
      if (!frame) return;

      this.db.addScreenshot({
        deviceId: this.config.deviceId,
        capturedAt: new Date().toISOString(),
        base64Image: frame.image,
        thumbnailBase64: frame.thumbnail,
        isBlurred: this.config.blurScreenshots,
      });

      console.log(
        '[ScreenshotEngine] Captured compressed JPEG for',
        this.config.deviceId,
        `(${Math.round(frame.image.length / 1024)}KB / thumb ${Math.round(frame.thumbnail.length / 1024)}KB)`,
      );
    } catch (err) {
      console.error('[ScreenshotEngine] Failed to capture screen', err);
    }
  }

  /** Live JPEG for streaming — not stored in the local queue. */
  public async captureFrame(opts?: {
    maxWidth?: number;
    quality?: number;
    thumbWidth?: number;
    thumbQuality?: number;
    skipIfIdle?: boolean;
  }): Promise<{ image: string; thumbnail: string } | null> {
    if (opts?.skipIfIdle && this.config.pauseOnIdle) {
      const idleTime = powerMonitor.getSystemIdleTime();
      if (idleTime >= this.config.trackIdleAfterSec) {
        console.log('[ScreenshotEngine] System idle, skipping screenshot capture');
        return null;
      }
    }

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1280, height: 720 },
    });

    if (!sources || sources.length === 0) {
      console.warn('[ScreenshotEngine] No screen sources found');
      return null;
    }

    const primarySource = sources[0];
    if (!primarySource) return null;

    const raw = primarySource.thumbnail;
    return {
      image: toJpegDataUrl(raw, opts?.maxWidth ?? 880, opts?.quality ?? 42),
      thumbnail: toJpegDataUrl(raw, opts?.thumbWidth ?? 320, opts?.thumbQuality ?? 40),
    };
  }
}

import { ErrorHandler, Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { APP_CONFIG } from './config';

@Injectable()
export class TelemetryErrorHandler implements ErrorHandler {
  private readonly http = inject(HttpClient);
  private reportTimes: number[] = [];

  handleError(error: unknown): void {
    console.error(error);
    const now = Date.now();
    this.reportTimes = this.reportTimes.filter((timestamp) => now - timestamp < 60_000);
    if (this.reportTimes.length >= 5) return;
    this.reportTimes.push(now);
    const actual = error instanceof Error ? error : new Error(String(error));
    this.http
      .post(`${APP_CONFIG.apiUrl}/telemetry`, {
        errors: [
          {
            message: actual.message,
            stack: actual.stack || '',
            ts: now,
            url: globalThis.location?.href || '',
          },
        ],
      })
      .subscribe({
        error: (reportError: unknown) =>
          console.warn('Unable to report the application error', reportError),
      });
  }
}

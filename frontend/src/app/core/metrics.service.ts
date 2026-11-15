import { Injectable, NgZone, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { APP_CONFIG } from './config';
import { MetricEvent, MetricSnapshot, Service, Transport } from './models';
import { AuthService } from './auth.service';
import {
  isValidMetricEvent,
  nextTransport,
  orderUniqueEvents,
  reconnectDelayMs,
} from './resilience';

@Injectable({ providedIn: 'root' })
export class MetricsService {
  readonly services = signal<Service[]>([]);
  readonly metrics = signal<Record<string, MetricEvent>>({});
  readonly transport = signal<Transport>('offline');
  readonly lastEventAt = signal<number | null>(null);
  readonly lastMetricEvent = signal<MetricEvent | null>(null);
  readonly malformedCount = signal(0);
  readonly duplicateCount = signal(0);
  readonly reorderedCount = signal(0);
  readonly stale = signal(true);
  readonly reconnectSeconds = signal(0);
  readonly clock = signal(Date.now());
  readonly error = signal<string | null>(null);
  readonly online = signal(navigator.onLine);
  private active = false;
  private source: WebSocket | EventSource | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private countdownTimer: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private staleTimer: ReturnType<typeof setInterval> | null = null;
  private climbTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private lastOffset = 0;
  private replayPending = false;
  private hasConnected = false;
  private serviceSeq = new Map<string, number>();
  private pendingEvents: MetricEvent[] = [];
  private pendingOffsets = new Set<number>();
  private lastReceivedOffset = 0;
  private pendingMalformedCount = 0;
  private pendingDuplicateCount = 0;
  private pendingReorderedCount = 0;
  private diagnosticTimer: ReturnType<typeof setTimeout> | null = null;
  private reorderTimer: ReturnType<typeof setTimeout> | null = null;
  private changedAt = new Map<string, number>();
  private onlineHandler = () => {
    this.online.set(true);
    if (this.active) this.connect('websocket');
  };
  private offlineHandler = () => {
    this.online.set(false);
    this.clearConnection();
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.transport.set('offline');
    this.replayPending = false;
    this.failures = 0;
    this.error.set(null);
  };

  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly zone = inject(NgZone);

  constructor() {
    window.addEventListener('online', this.onlineHandler);
    window.addEventListener('offline', this.offlineHandler);
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.loadInitialData();
    this.staleTimer = setInterval(() => {
      const last = this.lastEventAt();
      this.stale.set(last === null || Date.now() - last > APP_CONFIG.staleAfterMs);
      this.clock.set(Date.now());
    }, 1000);
    if (this.online()) this.connect('websocket');
    this.climbTimer = setInterval(() => {
      if (!this.active || !this.online()) return;
      if (this.transport() === 'polling') this.probeSse();
      else if (this.transport() === 'sse') this.probeWebSocket();
    }, 30_000);
  }

  stop(): void {
    this.active = false;
    this.clearConnection();
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.staleTimer) clearInterval(this.staleTimer);
    if (this.climbTimer) clearInterval(this.climbTimer);
    this.pollTimer = this.staleTimer = this.climbTimer = null;
    this.transport.set('offline');
    this.metrics.set({});
    this.services.set([]);
    this.lastEventAt.set(null);
    this.lastMetricEvent.set(null);
    this.lastOffset = 0;
    this.lastReceivedOffset = 0;
    this.hasConnected = false;
    this.serviceSeq.clear();
    this.changedAt.clear();
    this.malformedCount.set(0);
    this.duplicateCount.set(0);
    this.reorderedCount.set(0);
    this.pendingDuplicateCount = 0;
    this.pendingReorderedCount = 0;
    this.pendingMalformedCount = 0;
    if (this.diagnosticTimer) clearTimeout(this.diagnosticTimer);
    this.diagnosticTimer = null;
    this.stale.set(true);
  }

  changed(serviceId: string): boolean {
    const changedAt = this.changedAt.get(serviceId) || 0;
    return Date.now() - changedAt < 1000;
  }

  private loadInitialData(): void {
    this.http.get<Service[]>(`${APP_CONFIG.apiUrl}/services`).subscribe({
      next: (services) => this.services.set(services),
      error: (error: unknown) => this.error.set(this.errorMessage(error)),
    });
    this.http.get<MetricSnapshot>(`${APP_CONFIG.apiUrl}/metrics/snapshot`).subscribe({
      next: (snapshot) => this.applySnapshot(snapshot),
      error: (error: unknown) => this.error.set(this.errorMessage(error)),
    });
  }

  private connect(transport: 'websocket' | 'sse'): void {
    if (!this.active || !this.online()) return;
    this.clearConnection();
    this.transport.set(transport === 'websocket' ? 'reconnecting' : this.transport());
    this.auth.ensureFreshAccessToken().subscribe({
      next: (token) => this.openConnection(transport, token),
      error: () => {
        if (this.active) this.auth.logout();
      },
    });
  }

  private openConnection(transport: 'websocket' | 'sse', token: string): void {
    if (!this.active || !this.online()) return;
    const url = new URL(`${APP_CONFIG.apiUrl}/stream${transport === 'sse' ? '/sse' : ''}`);
    url.searchParams.set('access_token', token);

    if (transport === 'websocket') {
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(url.toString());
      this.source = socket;
      const connectTimeout = setTimeout(() => {
        if (socket.readyState !== WebSocket.OPEN) {
          socket.close();
          this.failed('websocket');
        }
      }, APP_CONFIG.wsConnectTimeoutMs);
      socket.onopen = () => {
        clearTimeout(connectTimeout);
        this.zone.run(() => {
          this.failures = 0;
          this.transport.set('websocket');
          this.armHeartbeat();
          if (this.hasConnected) this.requestReplay();
          this.hasConnected = true;
        });
      };
      socket.onmessage = (message) => this.handleRaw(message.data);
      socket.onerror = () => socket.close();
      socket.onclose = () => {
        clearTimeout(connectTimeout);
        if (this.active && this.source === socket) this.failed('websocket');
      };
      return;
    }

    const source = new EventSource(url.toString());
    this.source = source;
    source.onopen = () =>
      this.zone.run(() => {
        this.failures = 0;
        this.transport.set('sse');
        this.armHeartbeat();
        if (this.hasConnected) this.requestReplay();
        this.hasConnected = true;
      });
    source.onmessage = (event) => this.handleRaw(event.data);
    source.addEventListener('metric', (event) => this.handleRaw((event as MessageEvent).data));
    source.addEventListener('ping', (event) => this.handleRaw((event as MessageEvent).data));
    source.onerror = () => {
      source.close();
      if (this.active && this.source === source) this.failed('sse');
    };
  }

  private failed(transport: 'websocket' | 'sse'): void {
    if (!this.active || !this.online()) return;
    this.failures++;
    this.transport.set('reconnecting');
    this.clearConnection();
    const next = nextTransport(transport, this.failures);
    if (next === 'sse') {
      this.failures = 0;
      this.connect('sse');
      return;
    }
    if (next === 'polling') {
      this.startPolling();
      return;
    }
    const jitteredDelay = reconnectDelayMs(this.failures);
    this.reconnectSeconds.set(Math.ceil(jitteredDelay / 1000));
    if (this.countdownTimer) clearInterval(this.countdownTimer);
    this.countdownTimer = setInterval(() => {
      this.reconnectSeconds.update((seconds) => Math.max(0, seconds - 1));
    }, 1000);
    this.timer = setTimeout(() => {
      if (this.countdownTimer) clearInterval(this.countdownTimer);
      this.countdownTimer = null;
      this.reconnectSeconds.set(0);
      this.connect(transport);
    }, jitteredDelay);
  }

  private probeSse(): void {
    if (!this.active || !this.online()) return;
    this.auth.ensureFreshAccessToken().subscribe({
      next: (token) => this.openSseProbe(token),
      error: () => this.auth.logout(),
    });
  }

  private openSseProbe(token: string): void {
    if (!this.active || !this.online() || this.transport() !== 'polling') return;
    const url = new URL(`${APP_CONFIG.apiUrl}/stream/sse`);
    url.searchParams.set('access_token', token);
    const candidate = new EventSource(url.toString());
    let promoted = false;
    candidate.onopen = () => {
      if (!this.active || !this.online() || this.transport() !== 'polling')
        return candidate.close();
      promoted = true;
      if (this.pollTimer) clearInterval(this.pollTimer);
      this.pollTimer = null;
      this.clearConnection();
      this.source = candidate;
      this.failures = 0;
      this.transport.set('sse');
      this.armHeartbeat();
      this.requestReplay();
    };
    candidate.onmessage = (event) => this.handleRaw(event.data);
    candidate.addEventListener('metric', (event) => this.handleRaw((event as MessageEvent).data));
    candidate.addEventListener('ping', (event) => this.handleRaw((event as MessageEvent).data));
    candidate.onerror = () => {
      candidate.close();
      if (promoted && this.active && this.source === candidate) this.failed('sse');
    };
  }

  private probeWebSocket(): void {
    if (!this.active || !this.online()) return;
    this.auth.ensureFreshAccessToken().subscribe({
      next: (token) => this.openWebSocketProbe(token),
      error: () => this.auth.logout(),
    });
  }

  private openWebSocketProbe(token: string): void {
    if (!this.active || !this.online() || this.transport() !== 'sse') return;
    const url = new URL(`${APP_CONFIG.apiUrl}/stream`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('access_token', token);
    const candidate = new WebSocket(url.toString());
    let promoted = false;
    const connectTimeout = setTimeout(() => {
      if (candidate.readyState !== WebSocket.OPEN) candidate.close();
    }, APP_CONFIG.wsConnectTimeoutMs);
    candidate.onopen = () => {
      clearTimeout(connectTimeout);
      if (!this.active || !this.online() || this.transport() !== 'sse') return candidate.close();
      promoted = true;
      this.clearConnection();
      this.source = candidate;
      this.failures = 0;
      this.transport.set('websocket');
      this.armHeartbeat();
      this.requestReplay();
    };
    candidate.onmessage = (message) => this.handleRaw(message.data);
    candidate.onerror = () => candidate.close();
    candidate.onclose = () => {
      clearTimeout(connectTimeout);
      if (promoted && this.active && this.source === candidate) this.failed('websocket');
    };
  }

  private startPolling(): void {
    this.clearConnection();
    this.transport.set('polling');
    if (this.pollTimer) clearInterval(this.pollTimer);
    void this.pollSnapshot();
    this.pollTimer = setInterval(() => void this.pollSnapshot(), 2000);
  }

  private async pollSnapshot(): Promise<void> {
    if (!this.active || !this.online()) return;
    this.http.get<MetricSnapshot>(`${APP_CONFIG.apiUrl}/metrics/snapshot`).subscribe({
      next: (snapshot) => this.applySnapshot(snapshot),
      error: (error: unknown) => this.error.set(this.errorMessage(error)),
    });
  }

  private handleRaw(raw: unknown): void {
    this.zone.run(() => {
      let event: unknown;
      try {
        event = JSON.parse(String(raw));
      } catch {
        this.pendingMalformedCount++;
        this.scheduleDiagnosticFlush();
        return;
      }
      if (!event || typeof event !== 'object') return this.markMalformed();
      const data = event as { type?: string; ts?: number; [key: string]: unknown };
      if (data.type === 'ping') {
        this.armHeartbeat();
        return;
      }
      if (data.type !== 'metric' || !isValidMetricEvent(event)) return this.markMalformed();
      this.armHeartbeat();
      this.queueEvent(event);
    });
  }

  private markMalformed(): void {
    this.pendingMalformedCount++;
    this.scheduleDiagnosticFlush();
  }

  private queueEvent(event: MetricEvent): void {
    if (event.offset <= this.lastOffset || this.pendingOffsets.has(event.offset)) {
      this.pendingDuplicateCount++;
      this.scheduleDiagnosticFlush();
      return;
    }
    if (event.offset < this.lastReceivedOffset) {
      this.pendingReorderedCount++;
      this.scheduleDiagnosticFlush();
    }
    this.lastReceivedOffset = Math.max(this.lastReceivedOffset, event.offset);
    this.pendingEvents.push(event);
    this.pendingOffsets.add(event.offset);
    if (!this.reorderTimer) {
      this.reorderTimer = setTimeout(() => {
        this.reorderTimer = null;
        const ordered = orderUniqueEvents(this.pendingEvents, this.lastOffset, this.serviceSeq);
        this.pendingEvents = [];
        this.pendingOffsets.clear();
        this.applyEvents(ordered);
      }, 1000);
    }
  }

  private applyEvents(events: MetricEvent[]): void {
    if (!events.length) return;
    const updated = { ...this.metrics() };
    let newest: MetricEvent | null = null;
    for (const event of events) {
      if (
        event.offset <= this.lastOffset ||
        event.seq <= (this.serviceSeq.get(event.serviceId) || 0)
      )
        continue;
      if (this.active && this.online() && this.lastOffset && event.offset > this.lastOffset + 1)
        this.requestReplay();
      const previous = updated[event.serviceId];
      if (previous?.status !== event.status) this.changedAt.set(event.serviceId, Date.now());
      updated[event.serviceId] = event;
      this.serviceSeq.set(event.serviceId, event.seq);
      this.lastOffset = event.offset;
      newest = event;
    }
    if (!newest) return;
    this.metrics.set(updated);
    this.lastEventAt.set(Date.now());
    this.lastMetricEvent.set(newest);
    this.stale.set(false);
    this.error.set(null);
  }

  private scheduleDiagnosticFlush(): void {
    if (this.diagnosticTimer) return;
    this.diagnosticTimer = setTimeout(() => {
      this.diagnosticTimer = null;
      this.flushDiagnostics();
    }, 1000);
  }

  private flushDiagnostics(): void {
    if (this.pendingMalformedCount) {
      this.malformedCount.update((count) => count + this.pendingMalformedCount);
      console.warn(`Ignored ${this.pendingMalformedCount} malformed stream frames`);
    }
    this.duplicateCount.update((count) => count + this.pendingDuplicateCount);
    this.reorderedCount.update((count) => count + this.pendingReorderedCount);
    this.pendingMalformedCount = 0;
    this.pendingDuplicateCount = 0;
    this.pendingReorderedCount = 0;
  }

  private applySnapshot(snapshot: MetricSnapshot): void {
    if (snapshot.offset < this.lastOffset) return;
    const metrics: Record<string, MetricEvent> = {};
    for (const event of snapshot.metrics) {
      if (isValidMetricEvent(event)) {
        metrics[event.serviceId] = event;
        this.serviceSeq.set(event.serviceId, event.seq);
      }
    }
    this.metrics.set(metrics);
    this.lastOffset = Math.max(this.lastOffset, snapshot.offset);
    this.lastReceivedOffset = Math.max(this.lastReceivedOffset, snapshot.offset);
    this.lastEventAt.set(snapshot.ts);
    this.stale.set(Date.now() - snapshot.ts > APP_CONFIG.staleAfterMs);
  }

  private requestReplay(): void {
    if (this.replayPending) return;
    this.replayPending = true;
    this.http
      .get<{ events: MetricEvent[]; offset: number }>(`${APP_CONFIG.apiUrl}/metrics/replay`, {
        params: { since: String(this.lastOffset) },
      })
      .subscribe({
        next: (response) => {
          for (const event of response.events) {
            if (
              isValidMetricEvent(event) &&
              event.offset > this.lastOffset &&
              !this.pendingOffsets.has(event.offset)
            ) {
              this.pendingEvents.push(event);
              this.pendingOffsets.add(event.offset);
            }
          }
          if (this.pendingEvents.length) {
            if (this.reorderTimer) clearTimeout(this.reorderTimer);
            this.reorderTimer = setTimeout(() => {
              this.reorderTimer = null;
              const ordered = orderUniqueEvents(
                this.pendingEvents,
                this.lastOffset,
                this.serviceSeq,
              );
              this.pendingEvents = [];
              this.pendingOffsets.clear();
              this.applyEvents(ordered);
            }, 1000);
          }
          this.replayPending = false;
        },
        error: (error: { status?: number }) => {
          if (error.status === 410) {
            this.http.get<MetricSnapshot>(`${APP_CONFIG.apiUrl}/metrics/snapshot`).subscribe({
              next: (snapshot) => {
                this.applySnapshot(snapshot);
                this.replayPending = false;
              },
              error: (snapshotError: unknown) => {
                this.error.set(this.errorMessage(snapshotError));
                this.replayPending = false;
              },
            });
          } else {
            this.error.set(this.errorMessage(error));
            this.replayPending = false;
          }
        },
      });
  }

  private armHeartbeat(): void {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = setTimeout(() => {
      if (this.active && this.transport() !== 'polling')
        this.failed(this.transport() === 'sse' ? 'sse' : 'websocket');
    }, APP_CONFIG.heartbeatIntervalMs * 2);
  }

  private clearConnection(): void {
    this.flushDiagnostics();
    if (this.pendingEvents.length) {
      if (this.reorderTimer) clearTimeout(this.reorderTimer);
      this.reorderTimer = null;
      const ordered = orderUniqueEvents(this.pendingEvents, this.lastOffset, this.serviceSeq);
      this.pendingEvents = [];
      this.pendingOffsets.clear();
      this.applyEvents(ordered);
    }
    if (this.timer) clearTimeout(this.timer);
    if (this.countdownTimer) clearInterval(this.countdownTimer);
    if (this.diagnosticTimer) clearTimeout(this.diagnosticTimer);
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    if (this.reorderTimer) clearTimeout(this.reorderTimer);
    this.timer = this.heartbeatTimer = null;
    this.countdownTimer = null;
    this.reconnectSeconds.set(0);
    this.reorderTimer = null;
    this.diagnosticTimer = null;
    this.pendingEvents = [];
    this.pendingOffsets.clear();
    const source = this.source;
    this.source = null;
    if (source instanceof WebSocket) {
      source.onclose = null;
      source.close();
    } else if (source instanceof EventSource) {
      source.close();
    }
  }

  private errorMessage(error: unknown): string {
    if (error && typeof error === 'object' && 'message' in error) return String(error.message);
    return 'Unable to load current fleet data.';
  }
}

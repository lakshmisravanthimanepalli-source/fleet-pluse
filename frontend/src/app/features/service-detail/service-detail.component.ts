import {
  AfterViewInit,
  Component,
  DestroyRef,
  ElementRef,
  ViewChild,
  effect,
  inject,
  signal,
} from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { Chart } from 'chart.js/auto';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { APP_CONFIG } from '../../core/config';
import { MetricEvent, MetricPoint, Service } from '../../core/models';
import { MetricsService } from '../../core/metrics.service';
import { downsamplePoints } from '../../core/resilience';

@Component({
  standalone: true,
  imports: [RouterLink, MatIconModule, FormsModule],
  template: `
    <a class="back-link" routerLink="/">← Back to fleet</a>
    @if (error()) {
      <div class="detail-error" role="alert">
        <mat-icon>error_outline</mat-icon>
        <div>
          <strong>Unable to load service history</strong><span>{{ error() }}</span>
        </div>
        <button (click)="loadHistory()">Retry</button>
      </div>
    }
    @if (service(); as current) {
      <section class="detail-head">
        <div>
          <div class="crumb">FLEET <span>/</span> SERVICE DETAILS</div>
          <div class="service-title">
            <span class="service-avatar">{{ current.name.charAt(0).toUpperCase() }}</span>
            <div>
              <h1>{{ current.name }}</h1>
              <p>{{ current.id }} <span>·</span> {{ current.team }} team</p>
            </div>
          </div>
        </div>
        <span
          class="status-badge"
          [class]="metrics.metrics()[current.id]?.status || current.status"
          >{{ metrics.metrics()[current.id]?.status || current.status }}</span
        >
      </section>
      <div class="metrics-strip">
        <div>
          <span>P95 LATENCY</span><strong>{{ liveMetric()?.p95 ?? '—' }} <small>ms</small></strong>
        </div>
        <div>
          <span>ERROR RATE</span
          ><strong>{{ liveMetric()?.errRate ?? '—' }} <small>%</small></strong>
        </div>
        <div>
          <span>REQUESTS / SEC</span
          ><strong>{{ liveMetric()?.rps ?? '—' }} <small>req/s</small></strong>
        </div>
        <div class="range-control">
          <label for="time-range">WINDOW</label
          ><select id="time-range" [ngModel]="minutes()" (ngModelChange)="changeRange($event)">
            <option [ngValue]="5">5 minutes</option>
            <option [ngValue]="15">15 minutes</option>
            <option [ngValue]="60">60 minutes</option>
          </select>
        </div>
      </div>
      <section class="chart-section">
        <div class="section-title">
          <div>
            <h2>Service performance</h2>
            <p>Historical data with live updates · Last {{ minutes() }} minutes</p>
          </div>
          <span class="live-label"><i></i> LIVE</span>
        </div>
        @if (loading()) {
          <div class="chart-loading">Loading historical metrics…</div>
        }
        <div class="chart-grid" [class.hidden]="loading()">
          <article class="chart-card">
            <div class="chart-title">
              <span class="chart-icon latency"><mat-icon>speed</mat-icon></span>
              <div>
                <h3>P95 latency</h3>
                <span>Milliseconds</span>
              </div>
            </div>
            <div class="canvas-wrap">
              <canvas #latencyChart aria-label="P95 latency line chart"></canvas>
            </div>
          </article>
          <article class="chart-card">
            <div class="chart-title">
              <span class="chart-icon errors"><mat-icon>warning_amber</mat-icon></span>
              <div>
                <h3>Error rate</h3>
                <span>Percentage</span>
              </div>
            </div>
            <div class="canvas-wrap">
              <canvas #errorChart aria-label="Error rate line chart"></canvas>
            </div>
          </article>
          <article class="chart-card">
            <div class="chart-title">
              <span class="chart-icon throughput"><mat-icon>swap_vert</mat-icon></span>
              <div>
                <h3>Throughput</h3>
                <span>Requests / second</span>
              </div>
            </div>
            <div class="canvas-wrap">
              <canvas #throughputChart aria-label="Requests per second line chart"></canvas>
            </div>
          </article>
        </div>
        <div class="chart-note">
          <mat-icon>info_outline</mat-icon> Charts retain at most {{ pointLimit }} points per
          series. Historical data is uniformly sampled to the display limit; new live samples
          replace the oldest point.
        </div>
      </section>
    } @else if (!error()) {
      <div class="chart-loading">Loading service…</div>
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .back-link {
        display: inline-block;
        margin: 0 0 21px;
        color: #788799;
        text-decoration: none;
        font-size: 11px;
      }
      .back-link:hover {
        color: #227b57;
      }
      .detail-head {
        display: flex;
        justify-content: space-between;
        align-items: flex-end;
        margin-bottom: 20px;
      }
      .crumb {
        font-size: 9px;
        color: #95a0ad;
        font-weight: 700;
        letter-spacing: 1px;
      }
      .crumb span {
        margin: 0 7px;
        color: #c5ccd4;
      }
      .service-title {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-top: 12px;
      }
      .service-avatar {
        width: 42px;
        height: 42px;
        border-radius: 10px;
        background: #e8f2ed;
        color: #2d815f;
        display: grid;
        place-items: center;
        font-size: 16px;
        font-weight: 700;
      }
      h1 {
        margin: 0;
        color: #253447;
        font-size: 24px;
        letter-spacing: -0.7px;
      }
      .service-title p {
        margin: 5px 0 0;
        color: #8895a4;
        font-size: 11px;
      }
      .service-title p span {
        margin: 0 5px;
      }
      .status-badge {
        text-transform: capitalize;
        padding: 6px 10px;
        border-radius: 20px;
        font-size: 10px;
        font-weight: 650;
      }
      .status-badge.healthy {
        background: #e8f4ec;
        color: #25805a;
      }
      .status-badge.degraded {
        background: #fbf1e2;
        color: #b87520;
      }
      .status-badge.down {
        background: #fcebea;
        color: #c84f46;
      }
      .metrics-strip {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        background: #fff;
        border: 1px solid #e8edf2;
        border-radius: 9px;
        margin-bottom: 20px;
      }
      .metrics-strip > div {
        padding: 16px 19px;
        border-right: 1px solid #edf0f4;
      }
      .metrics-strip > div:last-child {
        border: 0;
      }
      .metrics-strip span {
        display: block;
        color: #95a0ad;
        font-size: 9px;
        font-weight: 700;
        letter-spacing: 0.5px;
      }
      .metrics-strip strong {
        display: block;
        margin-top: 9px;
        color: #2e3e50;
        font-size: 20px;
      }
      .metrics-strip small {
        font-size: 10px;
        color: #98a3b0;
        font-weight: 450;
      }
      .metrics-strip .range-control label {
        display: block;
        color: #95a0ad;
        font-size: 9px;
        font-weight: 700;
        letter-spacing: 0.5px;
      }
      .range-control select {
        margin-top: 7px;
        border: 1px solid #e0e6eb;
        border-radius: 5px;
        background: #fff;
        padding: 6px;
        color: #4c5a6c;
        font-size: 10px;
      }
      .chart-section {
        background: #fff;
        border: 1px solid #e8edf2;
        border-radius: 9px;
        padding: 18px 20px;
      }
      .section-title {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 15px;
      }
      .section-title h2 {
        margin: 0;
        color: #29384a;
        font-size: 14px;
      }
      .section-title p {
        margin: 5px 0 0;
        color: #98a3b0;
        font-size: 10px;
      }
      .live-label {
        display: flex;
        align-items: center;
        gap: 6px;
        color: #378364;
        font-size: 9px;
        font-weight: 700;
        letter-spacing: 0.6px;
      }
      .live-label i {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: #32a476;
      }
      .chart-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 13px;
      }
      .chart-grid.hidden {
        visibility: hidden;
        height: 0;
        overflow: hidden;
      }
      .chart-card {
        border: 1px solid #edf0f4;
        border-radius: 7px;
        padding: 13px 12px 8px;
        min-width: 0;
      }
      .chart-title {
        display: flex;
        align-items: center;
        gap: 9px;
      }
      .chart-title h3 {
        margin: 0;
        color: #354356;
        font-size: 11px;
      }
      .chart-title span {
        display: block;
        margin-top: 4px;
        color: #9aa5b1;
        font-size: 9px;
      }
      .chart-icon {
        width: 27px;
        height: 27px;
        display: grid;
        place-items: center;
        border-radius: 7px;
      }
      .chart-icon mat-icon {
        width: 15px;
        height: 15px;
        font-size: 15px;
      }
      .latency {
        background: #eaf1ff;
        color: #5079bd;
      }
      .errors {
        background: #fff1e9;
        color: #cf7a47;
      }
      .throughput {
        background: #eeeaff;
        color: #7a66ba;
      }
      .canvas-wrap {
        height: 190px;
        margin-top: 10px;
      }
      .chart-note {
        display: flex;
        align-items: center;
        gap: 7px;
        margin-top: 14px;
        color: #8794a2;
        font-size: 9px;
      }
      .chart-note mat-icon {
        width: 15px;
        height: 15px;
        font-size: 15px;
        color: #9ba7b3;
      }
      .chart-loading {
        padding: 70px 20px;
        text-align: center;
        color: #8b97a4;
        font-size: 12px;
      }
      .detail-error {
        display: flex;
        align-items: center;
        gap: 10px;
        background: #fff0ee;
        border: 1px solid #f3d9d5;
        padding: 13px;
        border-radius: 7px;
        color: #ad443c;
      }
      .detail-error div {
        flex: 1;
      }
      .detail-error strong,
      .detail-error span {
        display: block;
        font-size: 11px;
      }
      .detail-error span {
        margin-top: 4px;
        font-size: 10px;
      }
      .detail-error button {
        border: 1px solid #edc7c1;
        border-radius: 5px;
        background: #fff;
        color: #a74138;
        padding: 7px 10px;
        font-size: 10px;
        cursor: pointer;
      }
      @media (max-width: 850px) {
        .chart-grid {
          grid-template-columns: 1fr;
        }
        .canvas-wrap {
          height: 210px;
        }
        .metrics-strip {
          grid-template-columns: repeat(2, 1fr);
        }
        .metrics-strip > div:nth-child(2) {
          border-right: 0;
        }
        .metrics-strip > div:nth-child(-n + 2) {
          border-bottom: 1px solid #edf0f4;
        }
      }
    `,
  ],
})
export class ServiceDetailComponent implements AfterViewInit {
  @ViewChild('latencyChart') latencyCanvas?: ElementRef<HTMLCanvasElement>;
  @ViewChild('errorChart') errorCanvas?: ElementRef<HTMLCanvasElement>;
  @ViewChild('throughputChart') throughputCanvas?: ElementRef<HTMLCanvasElement>;
  readonly pointLimit = APP_CONFIG.chartPointLimit;
  readonly metrics = inject(MetricsService);
  readonly service = signal<Service | null>(null);
  readonly loading = signal(true);
  readonly error = signal('');
  readonly minutes = signal(15);
  private readonly route = inject(ActivatedRoute);
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);
  private points: MetricPoint[] = [];
  private charts: Chart<'line'>[] = [];
  private initialized = false;
  private activeId = '';

  constructor() {
    this.route.paramMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      const id = params.get('id') || '';
      if (id !== this.activeId) {
        this.activeId = id;
        this.charts.forEach((chart) => chart.destroy());
        this.charts = [];
        this.initialized = false;
        this.points = [];
        this.loading.set(true);
        this.error.set('');
        this.loadHistory();
      }
    });
    effect(() => {
      const currentService = this.metrics
        .services()
        .find((service) => service.id === this.activeId);
      if (currentService) this.service.set(currentService);
      const event = this.metrics.lastMetricEvent();
      if (event && event.serviceId === this.activeId && !this.loading()) this.addLivePoint(event);
    });
  }

  ngAfterViewInit(): void {
    this.initialized = true;
    this.renderCharts();
  }

  loadHistory(): void {
    const id = this.activeId;
    if (!id) return;
    this.service.set(
      this.metrics.services().find((service) => service.id === id) || {
        id,
        name: id,
        team: 'unknown',
        status: 'healthy',
      },
    );
    this.loading.set(true);
    this.http
      .get<{ serviceId: string; points: MetricPoint[] }>(`${APP_CONFIG.apiUrl}/metrics/history`, {
        params: { serviceId: id, minutes: String(this.minutes()) },
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          if (id !== this.activeId) return;
          this.points = this.reducePoints(response.points);
          this.loading.set(false);
          setTimeout(() => this.renderCharts());
        },
        error: (error: { message?: string }) => {
          this.error.set(error.message || 'History request failed.');
          this.loading.set(false);
        },
      });
  }

  liveMetric(): MetricEvent | undefined {
    const id = this.service()?.id;
    return id ? this.metrics.metrics()[id] : undefined;
  }

  changeRange(minutes: number): void {
    if (![5, 15, 60].includes(minutes)) return;
    this.minutes.set(minutes);
    this.loadHistory();
  }

  private reducePoints(points: MetricPoint[]): MetricPoint[] {
    return downsamplePoints(points, this.pointLimit);
  }

  private addLivePoint(event: MetricEvent): void {
    this.points.push({ ts: event.ts, p95: event.p95, errRate: event.errRate, rps: event.rps });
    if (this.points.length > this.pointLimit)
      this.points.splice(0, this.points.length - this.pointLimit);
    this.updateCharts();
  }

  private renderCharts(): void {
    if (
      !this.initialized ||
      this.loading() ||
      !this.latencyCanvas ||
      !this.errorCanvas ||
      !this.throughputCanvas
    )
      return;
    this.charts.forEach((chart) => chart.destroy());
    const definitions = [
      {
        canvas: this.latencyCanvas.nativeElement,
        key: 'p95' as const,
        color: '#5984c7',
        fill: 'rgba(89,132,199,.09)',
      },
      {
        canvas: this.errorCanvas.nativeElement,
        key: 'errRate' as const,
        color: '#d88759',
        fill: 'rgba(216,135,89,.09)',
      },
      {
        canvas: this.throughputCanvas.nativeElement,
        key: 'rps' as const,
        color: '#8774ca',
        fill: 'rgba(135,116,202,.09)',
      },
    ];
    this.charts = definitions.map(
      ({ canvas, key, color, fill }) =>
        new Chart(canvas, {
          type: 'line',
          data: {
            labels: this.points.map((point) =>
              new Date(point.ts).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
              }),
            ),
            datasets: [
              {
                data: this.points.map((point) => point[key]),
                borderColor: color,
                backgroundColor: fill,
                fill: true,
                pointRadius: 0,
                borderWidth: 1.7,
                tension: 0.25,
              },
            ],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            plugins: { legend: { display: false } },
            scales: {
              x: { display: false },
              y: {
                grid: { color: '#f0f2f5' },
                border: { display: false },
                ticks: { color: '#9aa5b0', font: { size: 9 }, maxTicksLimit: 4 },
              },
            },
          },
        }),
    );
  }

  private updateCharts(): void {
    this.charts.forEach((chart, index) => {
      const key = (['p95', 'errRate', 'rps'] as const)[index];
      chart.data.labels = this.points.map((point) =>
        new Date(point.ts).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }),
      );
      chart.data.datasets[0].data = this.points.map((point) => point[key]);
      chart.update('none');
    });
  }
}

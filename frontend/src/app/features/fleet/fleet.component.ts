import { Component, computed, effect, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { ScrollingModule } from '@angular/cdk/scrolling';
import { MatIconModule } from '@angular/material/icon';
import { MetricEvent, ServiceStatus } from '../../core/models';
import { MetricsService } from '../../core/metrics.service';
import { APP_CONFIG } from '../../core/config';

type SortKey = 'name' | 'team' | 'status' | 'p95' | 'errRate' | 'rps';

@Component({
  standalone: true,
  imports: [CommonModule, FormsModule, ScrollingModule, MatIconModule, RouterLink],
  template: `
    <section class="page-head">
      <div>
        <div class="breadcrumb">OPERATIONS <span>/</span> FLEET OVERVIEW</div>
        <h1>Fleet overview</h1>
        <p class="subtitle">Real-time health and performance across your services.</p>
      </div>
      <div class="updated-tag">
        <span class="live-pip"></span> Live monitoring <span class="divider"></span>
        {{ metrics.services().length | number }} services
      </div>
    </section>

    @if (metrics.stale()) {
      <div class="stale-banner" role="status">
        <mat-icon>warning_amber</mat-icon>
        <div>
          <strong>Data may be out of date</strong
          ><span
            >Last update {{ ageLabel() }}. Values are marked stale until the feed recovers.</span
          >
        </div>
      </div>
    }
    @if (metrics.error()) {
      <div class="error-banner" role="alert">{{ metrics.error() }}</div>
    }

    <div class="summary-grid">
      <article class="summary-card">
        <div class="summary-top">
          <span>Total services</span
          ><span class="summary-icon neutral"><mat-icon>dns</mat-icon></span>
        </div>
        <strong>{{ metrics.services().length | number }}</strong><small>Across all teams</small>
      </article>
      <article class="summary-card">
        <div class="summary-top">
          <span>Healthy</span
          ><span class="summary-icon green"><mat-icon>check_circle</mat-icon></span>
        </div>
        <strong>{{ statusCount('healthy') | number }}</strong><small class="good-copy"
          >Operating normally</small
        >
      </article>
      <article class="summary-card">
        <div class="summary-top">
          <span>Degraded</span><span class="summary-icon amber"><mat-icon>warning</mat-icon></span>
        </div>
        <strong>{{ statusCount('degraded') | number }}</strong><small class="amber-copy"
          >Requires attention</small
        >
      </article>
      <article class="summary-card">
        <div class="summary-top">
          <span>Down</span><span class="summary-icon red"><mat-icon>error</mat-icon></span>
        </div>
        <strong>{{ statusCount('down') | number }}</strong><small class="red-copy"
          >Needs immediate action</small
        >
      </article>
    </div>

    <section class="table-card">
      <div class="table-heading">
        <div>
          <h2>Services</h2>
          <p>Live metrics · Updates in place</p>
        </div>
        <span class="stream-pill"
          ><span></span
          >{{
            metrics.transport() === 'polling'
              ? 'Polling'
              : metrics.transport() === 'offline'
                ? 'Offline'
                : metrics.transport() === 'reconnecting'
                  ? 'Reconnecting'
                  : 'Stream connected'
          }}</span
        >
      </div>
      <div class="toolbar">
        <label class="search-box"
          ><mat-icon>search</mat-icon
          ><input
            aria-label="Search services"
            placeholder="Search services or teams..."
            [ngModel]="search()"
            (ngModelChange)="search.set($event); updateUrl()"
          /><kbd>⌘ K</kbd></label
        >
        <label class="filter-label" for="status-filter">Status</label>
        <select
          id="status-filter"
          [ngModel]="statusFilter()"
          (ngModelChange)="statusFilter.set($event); updateUrl()"
        >
          <option value="all">All statuses</option>
          <option value="healthy">Healthy</option>
          <option value="degraded">Degraded</option>
          <option value="down">Down</option>
        </select>
        <span class="result-count">{{ filtered().length | number }} results</span>
      </div>
      <div class="table-scroll">
        <div class="table-header service-row" role="row">
          <button role="columnheader" (click)="sortBy('name')">
            SERVICE <span>{{ sortMark('name') }}</span>
          </button>
          <button role="columnheader" (click)="sortBy('team')">
            TEAM <span>{{ sortMark('team') }}</span>
          </button>
          <button role="columnheader" (click)="sortBy('status')">
            STATUS <span>{{ sortMark('status') }}</span>
          </button>
          <button role="columnheader" (click)="sortBy('p95')">
            P95 LATENCY <span>{{ sortMark('p95') }}</span>
          </button>
          <button role="columnheader" (click)="sortBy('errRate')">
            ERROR RATE <span>{{ sortMark('errRate') }}</span>
          </button>
          <button role="columnheader" (click)="sortBy('rps')">
            REQ / SEC <span>{{ sortMark('rps') }}</span>
          </button>
          <span aria-hidden="true"></span>
        </div>
        <cdk-virtual-scroll-viewport
          [itemSize]="rowSize"
          class="viewport"
          [minBufferPx]="520"
          [maxBufferPx]="1040"
          role="rowgroup"
        >
          <a
            class="service-row data-row"
            *cdkVirtualFor="let service of filtered(); trackBy: trackService"
            [routerLink]="['/services', service.id]"
            role="row"
            [class.changed]="metrics.changed(service.id)"
          >
            <div class="service-name">
              <span class="service-glyph">{{ service.name.charAt(0).toUpperCase() }}</span><span
                ><strong>{{ service.name }}</strong
                ><small>{{ service.id }}</small></span
              >
            </div>
            <span class="team">{{ service.team }}</span>
            <span
              ><span class="status-badge" [class]="statusOf(service.id)">{{
                statusOf(service.id)
              }}</span></span
            >
            <strong class="metric">{{ metric(service.id)?.p95 ?? '—' }}<small> ms</small></strong>
            <strong class="metric">{{ metric(service.id)?.errRate ?? '—' }}<small>%</small></strong>
            <strong class="metric"
              >{{ metric(service.id)?.rps ?? 0 | number }}<small> req/s</small></strong
            >
            <mat-icon class="row-arrow">chevron_right</mat-icon>
          </a>
        </cdk-virtual-scroll-viewport>
        @if (filtered().length === 0) {
          <div class="empty-state">No services match these filters.</div>
        }
      </div>
      <div class="table-footer">
        <span>Virtualized list · {{ filtered().length | number }} services</span
        ><span><i></i> Updated continuously</span>
      </div>
    </section>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .page-head {
        display: flex;
        align-items: flex-end;
        justify-content: space-between;
        margin: 4px 0 25px;
      }
      .breadcrumb {
        color: #8b97a5;
        font-size: 9px;
        font-weight: 750;
        letter-spacing: 1px;
      }
      .breadcrumb span {
        margin: 0 7px;
        color: #c0c8d1;
      }
      h1 {
        margin: 11px 0 6px;
        color: #1e2b3b;
        font-size: 27px;
        letter-spacing: -0.8px;
      }
      .subtitle {
        margin: 0;
        color: #8491a0;
        font-size: 12px;
      }
      .updated-tag {
        display: flex;
        align-items: center;
        gap: 9px;
        color: #5f6e7f;
        font-size: 11px;
        background: #fff;
        border: 1px solid #e8edf2;
        padding: 9px 12px;
        border-radius: 7px;
      }
      .live-pip,
      .stream-pill span {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: #32a476;
        box-shadow: 0 0 0 3px #e4f3eb;
      }
      .divider {
        height: 14px;
        width: 1px;
        background: #e4e9ef;
        margin: 0 2px;
      }
      .summary-grid {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 14px;
        margin-bottom: 21px;
      }
      .summary-card,
      .table-card {
        background: #fff;
        border: 1px solid #e9edf2;
        border-radius: 9px;
      }
      .summary-card {
        padding: 17px 18px 15px;
      }
      .summary-top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        color: #788597;
        font-size: 11px;
        font-weight: 550;
      }
      .summary-card > strong {
        display: block;
        margin-top: 12px;
        font-size: 25px;
        color: #263547;
        letter-spacing: -0.6px;
      }
      .summary-card > small {
        display: block;
        margin-top: 5px;
        font-size: 10px;
        color: #9aa5b1;
      }
      .summary-icon {
        width: 29px;
        height: 29px;
        display: grid;
        place-items: center;
        border-radius: 7px;
      }
      .summary-icon mat-icon {
        width: 17px;
        height: 17px;
        font-size: 17px;
      }
      .neutral {
        background: #eef1f5;
        color: #78879a;
      }
      .green {
        background: #e8f5ed;
        color: #28835f;
      }
      .amber {
        background: #fbf1e2;
        color: #c98425;
      }
      .red {
        background: #fdecea;
        color: #d3554b;
      }
      .good-copy {
        color: #2c9368 !important;
      }
      .amber-copy {
        color: #c9892e !important;
      }
      .red-copy {
        color: #cf5a51 !important;
      }
      .table-card {
        overflow: hidden;
      }
      .table-heading {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 17px 20px;
      }
      .table-heading h2 {
        margin: 0 0 4px;
        font-size: 15px;
        color: #263547;
      }
      .table-heading p {
        margin: 0;
        color: #929eac;
        font-size: 10px;
      }
      .stream-pill {
        display: flex;
        align-items: center;
        gap: 8px;
        border: 1px solid #e7eee9;
        padding: 6px 9px;
        border-radius: 20px;
        color: #438265;
        font-size: 10px;
        background: #fbfdfb;
      }
      .stream-pill span {
        width: 6px;
        height: 6px;
      }
      .toolbar {
        min-height: 57px;
        display: flex;
        align-items: center;
        gap: 11px;
        padding: 0 20px;
        border-top: 1px solid #f0f2f5;
        border-bottom: 1px solid #edf0f4;
      }
      .search-box {
        display: flex;
        align-items: center;
        gap: 8px;
        width: min(340px, 45vw);
        height: 32px;
        border: 1px solid #e5e9ef;
        border-radius: 6px;
        padding: 0 9px;
        color: #9aa5b0;
      }
      .search-box mat-icon {
        font-size: 16px;
        width: 16px;
        height: 16px;
      }
      .search-box input {
        flex: 1;
        min-width: 0;
        border: 0;
        outline: 0;
        font: inherit;
        font-size: 10px;
        color: #344254;
      }
      kbd {
        font-size: 9px;
        color: #9da7b2;
        border: 1px solid #e7ebef;
        border-radius: 3px;
        padding: 2px 4px;
      }
      .filter-label {
        color: #8c98a7;
        font-size: 10px;
        margin-left: 5px;
      }
      select {
        height: 32px;
        border: 1px solid #e5e9ef;
        border-radius: 6px;
        background: #fff;
        color: #5b697a;
        padding: 0 24px 0 9px;
        font-size: 10px;
      }
      .result-count {
        margin-left: auto;
        color: #99a3ae;
        font-size: 10px;
      }
      .service-row {
        display: grid;
        grid-template-columns: minmax(190px, 1.7fr) 1fr 1fr 1fr 1fr 1fr 20px;
        align-items: center;
        gap: 12px;
        padding: 0 20px;
      }
      .table-header {
        height: 38px;
        background: #fafbfd;
        border-bottom: 1px solid #edf0f4;
      }
      .table-header button {
        padding: 0;
        border: 0;
        background: none;
        text-align: left;
        color: #98a3b0;
        font-size: 9px;
        letter-spacing: 0.45px;
        font-weight: 700;
        cursor: pointer;
      }
      .table-header button span {
        color: #338465;
      }
      .viewport {
        height: min(520px, 60vh);
        width: 100%;
      }
      .data-row {
        height: 52px;
        box-sizing: border-box;
        text-decoration: none;
        border-bottom: 1px solid #f1f3f6;
        color: #354355;
        cursor: pointer;
        transition: background 0.15s;
      }
      .data-row:hover {
        background: #f8fbf9;
      }
      .data-row.changed {
        animation: flash 900ms ease-out;
      }
      @keyframes flash {
        0% {
          background: #e0f5e9;
        }
        100% {
          background: #fff;
        }
      }
      .service-name {
        display: flex;
        align-items: center;
        gap: 10px;
        min-width: 0;
      }
      .service-glyph {
        width: 29px;
        height: 29px;
        flex: none;
        display: grid;
        place-items: center;
        background: #edf3f6;
        color: #648092;
        border-radius: 7px;
        font-size: 11px;
        font-weight: 700;
      }
      .service-name strong {
        display: block;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 11px;
        color: #354355;
      }
      .service-name small {
        display: block;
        margin-top: 3px;
        color: #a3acb7;
        font-size: 9px;
      }
      .team {
        color: #7f8c9b;
        font-size: 10px;
      }
      .status-badge {
        display: inline-flex;
        align-items: center;
        text-transform: capitalize;
        border-radius: 12px;
        padding: 4px 8px;
        font-size: 9px;
        font-weight: 650;
      }
      .status-badge.healthy {
        color: #27815c;
        background: #e9f5ee;
      }
      .status-badge.degraded {
        color: #b77721;
        background: #fbf2e5;
      }
      .status-badge.down {
        color: #c34d46;
        background: #fceceb;
      }
      .metric {
        font-size: 11px;
        color: #3b4a5b;
        font-weight: 600;
      }
      .metric small {
        font-weight: 400;
        color: #9aa4b0;
        font-size: 9px;
      }
      .row-arrow {
        color: #b9c1cb;
        font-size: 18px;
        width: 18px;
        height: 18px;
      }
      .table-footer {
        height: 37px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0 20px;
        color: #9aa5b0;
        font-size: 9px;
      }
      .table-footer span:last-child {
        display: flex;
        align-items: center;
        gap: 7px;
      }
      .table-footer i {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: #36a476;
      }
      .empty-state {
        padding: 30px;
        text-align: center;
        color: #8b97a5;
        font-size: 12px;
      }
      .stale-banner,
      .error-banner {
        display: flex;
        align-items: center;
        gap: 11px;
        padding: 12px 15px;
        margin-bottom: 15px;
        border-radius: 7px;
      }
      .stale-banner {
        background: #fff8e9;
        border: 1px solid #f1e2bf;
        color: #9d6c1d;
      }
      .stale-banner mat-icon {
        font-size: 19px;
        width: 19px;
        height: 19px;
      }
      .stale-banner strong,
      .stale-banner span {
        display: block;
        font-size: 11px;
      }
      .stale-banner span {
        margin-top: 3px;
        color: #aa8a52;
        font-size: 10px;
      }
      .error-banner {
        background: #fff0ee;
        color: #a94037;
        font-size: 11px;
      }
      @media (max-width: 850px) {
        .summary-grid {
          grid-template-columns: repeat(2, 1fr);
        }
        .page-head {
          align-items: flex-start;
          gap: 15px;
          flex-direction: column;
        }
        .service-row {
          grid-template-columns: 1.6fr 0.8fr 0.9fr 0.8fr 0.8fr 0.8fr 16px;
          padding: 0 12px;
          gap: 7px;
        }
        .table-header {
          font-size: 8px;
        }
        .team {
          overflow: hidden;
          text-overflow: ellipsis;
        }
      }
      @media (max-width: 600px) {
        .summary-grid {
          gap: 8px;
        }
        .summary-card {
          padding: 13px;
        }
        .toolbar {
          flex-wrap: wrap;
          padding: 10px;
        }
        .search-box {
          width: 100%;
        }
        .service-row {
          grid-template-columns: 1.5fr 0.8fr 0.8fr 0.8fr;
          gap: 8px;
        }
        .service-row > *:nth-child(2),
        .service-row > *:nth-child(5),
        .service-row > *:nth-child(7) {
          display: none;
        }
        .table-header button:nth-child(2),
        .table-header button:nth-child(5) {
          display: none;
        }
      }
    `,
  ],
})
export class FleetComponent {
  readonly metrics = inject(MetricsService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  readonly search = signal('');
  readonly statusFilter = signal('all');
  readonly sortKey = signal<SortKey>('name');
  readonly sortDirection = signal<'asc' | 'desc'>('asc');
  readonly rowSize = APP_CONFIG.virtualItemSizePx;
  readonly filtered = computed(() => {
    const query = this.search().trim().toLowerCase();
    const filter = this.statusFilter();
    const key = this.sortKey();
    const direction = this.sortDirection() === 'asc' ? 1 : -1;
    return this.metrics
      .services()
      .filter((service) => {
        const status = this.statusOf(service.id);
        const matchesStatus = filter === 'all' || status === filter;
        const matchesSearch =
          !query || `${service.name} ${service.id} ${service.team}`.toLowerCase().includes(query);
        return matchesStatus && matchesSearch;
      })
      .slice()
      .sort((a, b) => {
        const aMetric = this.metric(a.id);
        const bMetric = this.metric(b.id);
        const left =
          key === 'name'
            ? a.name
            : key === 'team'
              ? a.team
              : key === 'status'
                ? this.statusOf(a.id)
                : aMetric?.[key];
        const right =
          key === 'name'
            ? b.name
            : key === 'team'
              ? b.team
              : key === 'status'
                ? this.statusOf(b.id)
                : bMetric?.[key];
        return (
          (typeof left === 'number' && typeof right === 'number'
            ? left - right
            : String(left || '').localeCompare(String(right || ''))) * direction
        );
      });
  });

  constructor() {
    effect(() => this.metrics.metrics());
    this.route.queryParamMap.subscribe((params) => {
      this.search.set(params.get('q') || '');
      this.statusFilter.set(params.get('status') || 'all');
      this.sortKey.set((params.get('sort') as SortKey) || 'name');
      this.sortDirection.set(params.get('dir') === 'desc' ? 'desc' : 'asc');
    });
  }

  metric(id: string): MetricEvent | undefined {
    return this.metrics.metrics()[id];
  }

  statusOf(id: string): ServiceStatus {
    return this.metrics.metrics()[id]?.status || 'healthy';
  }

  statusCount(status: ServiceStatus): number {
    return this.metrics.services().filter((service) => this.statusOf(service.id) === status).length;
  }

  sortBy(key: SortKey): void {
    if (this.sortKey() === key)
      this.sortDirection.set(this.sortDirection() === 'asc' ? 'desc' : 'asc');
    else {
      this.sortKey.set(key);
      this.sortDirection.set('asc');
    }
    this.updateUrl();
  }

  sortMark(key: SortKey): string {
    return this.sortKey() === key ? (this.sortDirection() === 'asc' ? '↑' : '↓') : '';
  }

  updateUrl(): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        q: this.search() || null,
        status: this.statusFilter() === 'all' ? null : this.statusFilter(),
        sort: this.sortKey() === 'name' ? null : this.sortKey(),
        dir: this.sortDirection() === 'asc' ? null : 'desc',
      },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  ageLabel(): string {
    const timestamp = this.metrics.lastEventAt();
    return timestamp
      ? `${Math.floor((Date.now() - timestamp) / 1000)} seconds ago`
      : 'not received yet';
  }

  trackService(_index: number, service: { id: string }): string {
    return service.id;
  }
}

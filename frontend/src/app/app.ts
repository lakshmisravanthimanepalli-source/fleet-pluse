import { Component, effect, inject, signal } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { AuthService } from './core/auth.service';
import { MetricsService } from './core/metrics.service';
import { AssistantPanelComponent } from './features/assistant/assistant-panel.component';

@Component({
  selector: 'app-root',
  imports: [
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    MatButtonModule,
    MatIconModule,
    AssistantPanelComponent,
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  readonly auth = inject(AuthService);
  readonly metrics = inject(MetricsService);
  private readonly router = inject(Router);
  readonly assistantOpen = signal(false);

  constructor() {
    effect(() => {
      if (this.auth.user()) this.metrics.start();
      else this.metrics.stop();
    });
  }

  logout(): void {
    this.metrics.stop();
    this.auth.logout();
  }

  get connectionLabel(): string {
    this.metrics.clock();
    const names: Record<string, string> = {
      websocket: 'Live · WebSocket',
      sse: 'Live · SSE',
      polling: 'Polling',
      reconnecting: `Reconnecting${this.metrics.reconnectSeconds() ? ` in ${this.metrics.reconnectSeconds()} s` : ''}`,
      offline: 'Offline',
    };
    const transport = names[this.metrics.transport()] || 'Offline';
    if (!this.metrics.stale()) return transport;
    const last = this.metrics.lastEventAt();
    const freshness = last
      ? `stale · last event ${Math.floor((Date.now() - last) / 1000)}s ago`
      : 'waiting for data';
    return this.metrics.transport() === 'offline'
      ? `Offline · ${freshness}`
      : `${freshness} · ${transport}`;
  }

  get onLogin(): boolean {
    return this.router.url.startsWith('/login');
  }
}

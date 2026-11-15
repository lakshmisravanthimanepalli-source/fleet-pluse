import { Component, EventEmitter, Output, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { AuthService } from '../../core/auth.service';
import { APP_CONFIG } from '../../core/config';

@Component({
  selector: 'app-assistant-panel',
  standalone: true,
  imports: [FormsModule, MatIconModule],
  template: `
    <div
      class="assistant-backdrop"
      role="presentation"
      tabindex="-1"
      (click)="dismissed.emit()"
      (keydown.escape)="dismissed.emit()"
    ></div>
    <aside
      class="assistant-panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby="assistant-title"
    >
      <header>
        <span class="assistant-icon"><mat-icon>auto_awesome</mat-icon></span>
        <div>
          <h2 id="assistant-title">Ask Ops</h2>
          <p>Fleet Pulse assistant</p>
        </div>
        <button
          class="close"
          type="button"
          aria-label="Close assistant"
          (click)="stop(); dismissed.emit()"
        >
          <mat-icon>close</mat-icon>
        </button>
      </header>
      <div class="assistant-messages" aria-live="polite">
        @if (!answer() && !busy() && !error()) {
          <div class="welcome">
            <span>✦</span><strong>How can I help?</strong>
            <p>Ask about fleet health, service metrics, or active incidents.</p>
          </div>
        }
        @if (question()) {
          <div class="question">{{ question() }}</div>
        }
        @if (answer()) {
          <div class="answer" [innerHTML]="renderMarkdown(answer())"></div>
        }
        @if (busy()) {
          <div class="typing"><i></i><i></i><i></i><span>Analyzing fleet data…</span></div>
        }
        @if (error()) {
          <div class="assistant-error" role="alert">{{ error() }}</div>
        }
      </div>
      <form class="assistant-form" (ngSubmit)="submit()">
        <textarea
          name="questionInput"
          [(ngModel)]="draft"
          placeholder="Ask a question..."
          aria-label="Ask the operations assistant"
          rows="3"
          [disabled]="busy()"
        ></textarea>
        <div>
          <span>AI responses may be incomplete.</span
          ><button type="submit" [disabled]="!draft.trim() || busy()" aria-label="Send question">
            <mat-icon>arrow_upward</mat-icon>
          </button>
        </div>
      </form>
      @if (busy()) {
        <button class="stop-button" type="button" (click)="stop()">Stop response</button>
      }
    </aside>
  `,
  styles: [
    `
      :host {
        position: fixed;
        inset: 0;
        z-index: 20;
      }
      .assistant-backdrop {
        position: absolute;
        inset: 0;
        background: #15253655;
      }
      .assistant-panel {
        position: absolute;
        right: 0;
        top: 0;
        bottom: 0;
        width: min(400px, 100vw);
        background: #fff;
        box-shadow: -15px 0 50px #12253a25;
        display: flex;
        flex-direction: column;
      }
      header {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 17px;
        border-bottom: 1px solid #edf0f3;
      }
      .assistant-icon {
        width: 33px;
        height: 33px;
        display: grid;
        place-items: center;
        border-radius: 9px;
        background: #edf4f0;
        color: #398363;
      }
      .assistant-icon mat-icon {
        width: 18px;
        height: 18px;
        font-size: 18px;
      }
      header h2 {
        margin: 0;
        color: #2f3e50;
        font-size: 13px;
      }
      header p {
        margin: 4px 0 0;
        color: #9aa5b1;
        font-size: 9px;
      }
      .close {
        margin-left: auto;
        border: 0;
        background: none;
        color: #8895a4;
        cursor: pointer;
      }
      .close mat-icon {
        font-size: 18px;
      }
      .assistant-messages {
        flex: 1;
        overflow: auto;
        padding: 17px;
        display: flex;
        flex-direction: column;
        gap: 13px;
      }
      .welcome {
        margin: auto;
        max-width: 245px;
        text-align: center;
        color: #8b98a6;
      }
      .welcome > span {
        display: block;
        color: #528a6d;
        font-size: 25px;
      }
      .welcome strong {
        display: block;
        margin-top: 8px;
        color: #425165;
        font-size: 13px;
      }
      .welcome p {
        font-size: 10px;
        line-height: 1.6;
      }
      .question {
        align-self: flex-end;
        max-width: 85%;
        padding: 10px 12px;
        border-radius: 10px 10px 2px 10px;
        background: #eaf3ed;
        color: #3b4c42;
        font-size: 11px;
        line-height: 1.6;
      }
      .answer {
        max-width: 95%;
        padding: 11px 12px;
        border: 1px solid #edf0f3;
        border-radius: 2px 10px 10px 10px;
        color: #49586a;
        font-size: 11px;
        line-height: 1.65;
        white-space: normal;
      }
      .answer p {
        margin: 0 0 8px;
      }
      .answer ul {
        margin: 6px 0;
        padding-left: 17px;
      }
      .typing {
        display: flex;
        align-items: center;
        gap: 4px;
        color: #83909e;
        font-size: 10px;
      }
      .typing i {
        width: 5px;
        height: 5px;
        border-radius: 50%;
        background: #76a88d;
        animation: pulse 1s infinite alternate;
      }
      .typing i:nth-child(2) {
        animation-delay: 0.2s;
      }
      .typing i:nth-child(3) {
        animation-delay: 0.4s;
      }
      .typing span {
        margin-left: 5px;
      }
      @keyframes pulse {
        to {
          opacity: 0.3;
          transform: translateY(-2px);
        }
      }
      .assistant-error {
        padding: 10px;
        border-radius: 6px;
        background: #fff0ee;
        color: #aa443b;
        font-size: 10px;
      }
      .assistant-form {
        margin: 0 14px 12px;
        border: 1px solid #dfe5eb;
        border-radius: 8px;
        padding: 10px;
      }
      .assistant-form textarea {
        width: 100%;
        resize: none;
        border: 0;
        outline: 0;
        color: #344255;
        font: inherit;
        font-size: 11px;
      }
      .assistant-form > div {
        display: flex;
        align-items: center;
        justify-content: space-between;
        color: #a0a9b4;
        font-size: 8px;
      }
      .assistant-form button {
        width: 28px;
        height: 28px;
        border: 0;
        border-radius: 7px;
        background: #267d58;
        color: #fff;
        display: grid;
        place-items: center;
        cursor: pointer;
      }
      .assistant-form button:disabled {
        opacity: 0.4;
      }
      .assistant-form button mat-icon {
        font-size: 17px;
        width: 17px;
        height: 17px;
      }
      .stop-button {
        align-self: center;
        margin: 0 0 15px;
        border: 1px solid #e0e5eb;
        background: #fff;
        border-radius: 5px;
        padding: 6px 11px;
        color: #667487;
        font-size: 9px;
        cursor: pointer;
      }
    `,
  ],
})
export class AssistantPanelComponent {
  @Output() readonly dismissed = new EventEmitter<void>();
  private readonly auth = inject(AuthService);
  readonly question = signal('');
  readonly answer = signal('');
  readonly busy = signal(false);
  readonly error = signal('');
  draft = '';
  private source: EventSource | null = null;

  submit(): void {
    const text = this.draft.trim();
    if (!text) return;
    this.stop();
    this.question.set(text);
    this.answer.set('');
    this.error.set('');
    this.draft = '';
    this.busy.set(true);
    this.auth.ensureFreshAccessToken().subscribe({
      next: (token) => {
        if (this.busy()) this.openStream(text, token);
      },
      error: () => {
        this.error.set('Your session could not be refreshed. Please sign in again.');
        this.busy.set(false);
      },
    });
  }

  private openStream(text: string, token: string): void {
    const url = new URL(`${APP_CONFIG.apiUrl}/assistant/stream`);
    url.searchParams.set('access_token', token);
    url.searchParams.set('q', text);
    const source = new EventSource(url.toString());
    this.source = source;
    source.addEventListener('token', (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as { text?: string };
        this.answer.update((answer) => answer + (data.text || ''));
      } catch {
        this.error.set('The assistant sent an invalid response.');
      }
    });
    source.addEventListener('done', () => this.stop());
    source.addEventListener('error', (event) => {
      const message = (event as MessageEvent).data;
      this.error.set(
        typeof message === 'string' ? message : 'The assistant stream is unavailable.',
      );
      this.stop();
    });
    source.onerror = () => {
      if (this.busy()) {
        this.error.set('Connection to the assistant was interrupted.');
        this.stop();
      }
    };
  }

  stop(): void {
    this.source?.close();
    this.source = null;
    this.busy.set(false);
  }

  renderMarkdown(text: string): string {
    const escaped = text.replace(
      /[&<>"']/g,
      (character) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        })[character] || character,
    );
    return escaped
      .split(/\n{2,}/)
      .map(
        (paragraph) =>
          `<p>${paragraph
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.+?)\*/g, '<em>$1</em>')
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(/\n/g, '<br>')}</p>`,
      )
      .join('');
  }
}

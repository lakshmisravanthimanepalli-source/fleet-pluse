import { Component } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';

interface UserSettings {
  staleWarning: boolean;
  desktopNotifications: boolean;
  compactTable: boolean;
  refreshInterval: number;
}

@Component({
  standalone: true,
  imports: [FormsModule, MatIconModule],
  template: `
    <div class="page-head">
      <div>
        <div class="crumb">OPERATIONS <span>/</span> PREFERENCES</div>
        <h1>Settings</h1>
        <p>Customize your Fleet Pulse workspace.</p>
      </div>
    </div>
    <form #settingsForm="ngForm" (ngSubmit)="save()" class="settings-card">
      <div class="settings-heading">
        <span class="settings-icon"><mat-icon>tune</mat-icon></span>
        <div>
          <h2>Dashboard preferences</h2>
          <p>These preferences are saved in this browser.</p>
        </div>
      </div>
      <label class="setting-row"
        ><span
          ><strong>Show stale-data warning</strong
          ><small>Clearly mark dashboard data when the live feed is delayed.</small></span
        ><input type="checkbox" name="staleWarning" [(ngModel)]="settings.staleWarning"
      /></label>
      <label class="setting-row"
        ><span
          ><strong>Desktop notifications</strong
          ><small>Allow the browser to notify you when an alert fires.</small></span
        ><input
          type="checkbox"
          name="desktopNotifications"
          [(ngModel)]="settings.desktopNotifications"
      /></label>
      <label class="setting-row"
        ><span
          ><strong>Compact fleet rows</strong
          ><small>Use a denser service table layout.</small></span
        ><input type="checkbox" name="compactTable" [(ngModel)]="settings.compactTable"
      /></label>
      <label class="setting-row interval"
        ><span
          ><strong>Preferred refresh interval</strong
          ><small
            >Polling fallback interval (the stream remains real-time when available).</small
          ></span
        ><select name="refreshInterval" [(ngModel)]="settings.refreshInterval">
          <option [ngValue]="2">2 seconds</option>
          <option [ngValue]="5">5 seconds</option>
          <option [ngValue]="10">10 seconds</option>
        </select></label
      >
      <div class="save-row">
        <span role="status">{{ saved ? 'Preferences saved.' : '' }}</span><button type="submit">
          Save preferences
        </button>
      </div>
    </form>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .page-head {
        margin: 4px 0 23px;
      }
      .crumb {
        color: #919daa;
        font-size: 9px;
        font-weight: 750;
        letter-spacing: 1px;
      }
      .crumb span {
        margin: 0 7px;
        color: #c4cbd3;
      }
      h1 {
        margin: 10px 0 5px;
        color: #233246;
        font-size: 27px;
        letter-spacing: -0.8px;
      }
      .page-head p {
        margin: 0;
        color: #8793a1;
        font-size: 12px;
      }
      .settings-card {
        max-width: 760px;
        background: #fff;
        border: 1px solid #e8edf2;
        border-radius: 9px;
        padding: 0 20px;
      }
      .settings-heading {
        display: flex;
        align-items: center;
        gap: 11px;
        padding: 19px 0;
        border-bottom: 1px solid #edf0f3;
      }
      .settings-icon {
        width: 34px;
        height: 34px;
        display: grid;
        place-items: center;
        background: #eaf4ee;
        border-radius: 8px;
        color: #31835e;
      }
      .settings-icon mat-icon {
        font-size: 18px;
        width: 18px;
        height: 18px;
      }
      .settings-heading h2 {
        margin: 0;
        color: #334256;
        font-size: 13px;
      }
      .settings-heading p {
        margin: 5px 0 0;
        color: #97a2ae;
        font-size: 10px;
      }
      .setting-row {
        min-height: 65px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 20px;
        border-bottom: 1px solid #f0f2f5;
        cursor: pointer;
      }
      .setting-row strong,
      .setting-row small {
        display: block;
      }
      .setting-row strong {
        color: #3a495b;
        font-size: 11px;
      }
      .setting-row small {
        margin-top: 4px;
        color: #929eaa;
        font-size: 9px;
      }
      .setting-row input[type='checkbox'] {
        width: 16px;
        height: 16px;
        accent-color: #287e59;
      }
      .setting-row select {
        border: 1px solid #e0e6eb;
        border-radius: 5px;
        background: #fff;
        padding: 7px;
        color: #4c5a6c;
        font-size: 10px;
      }
      .save-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 15px 0;
      }
      .save-row span {
        color: #35815f;
        font-size: 10px;
      }
      .save-row button {
        background: #1e7855;
        color: #fff;
        border: 0;
        border-radius: 6px;
        padding: 9px 13px;
        font-size: 10px;
        font-weight: 650;
        cursor: pointer;
      }
    `,
  ],
})
export class SettingsComponent {
  saved = false;
  settings: UserSettings = this.load();

  save(): void {
    localStorage.setItem('fleet-pulse-settings', JSON.stringify(this.settings));
    this.saved = true;
    if (
      this.settings.desktopNotifications &&
      'Notification' in window &&
      Notification.permission === 'default'
    ) {
      void Notification.requestPermission();
    }
  }

  private load(): UserSettings {
    try {
      const saved = localStorage.getItem('fleet-pulse-settings');
      return saved
        ? { ...this.defaults(), ...(JSON.parse(saved) as Partial<UserSettings>) }
        : this.defaults();
    } catch {
      return this.defaults();
    }
  }

  private defaults(): UserSettings {
    return {
      staleWarning: true,
      desktopNotifications: false,
      compactTable: false,
      refreshInterval: 2,
    };
  }
}

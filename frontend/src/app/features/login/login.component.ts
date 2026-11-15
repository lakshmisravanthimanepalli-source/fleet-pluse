import { Component, inject, signal } from '@angular/core';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { AuthService } from '../../core/auth.service';

@Component({
  standalone: true,
  imports: [ReactiveFormsModule, MatButtonModule],
  template: `
    <section class="login-page">
      <div class="login-art">
        <a class="login-brand"><span class="brand-glyph">◈</span> fleet<span>pulse</span></a>
        <div class="art-copy">
          <div class="eyebrow"><span class="pulse"></span> OPERATIONS CENTER</div>
          <h1>Clarity when<br />every second counts.</h1>
          <p>Real-time visibility across your entire service fleet.</p>
        </div>
        <div class="art-stats">
          <div><strong>2,000</strong><span>services monitored</span></div>
          <div><strong>24/7</strong><span>live intelligence</span></div>
        </div>
        <div class="decor-grid"></div>
      </div>
      <div class="login-panel">
        <div class="login-form-wrap">
          <div class="mobile-brand">◈ fleet<span>pulse</span></div>
          <div class="eyebrow dark">WELCOME BACK</div>
          <h2>Sign in to Fleet Pulse</h2>
          <p class="form-intro">Enter your credentials to access your operations dashboard.</p>
          <form [formGroup]="form" (ngSubmit)="submit()" novalidate>
            <label for="email">Work email</label>
            <input
              id="email"
              type="email"
              formControlName="email"
              autocomplete="username"
              placeholder="you@company.com"
            />
            @if (form.controls.email.touched && form.controls.email.invalid) {
              <span class="field-error">Enter a valid email address.</span>
            }
            <label for="password">Password</label>
            <input
              id="password"
              type="password"
              formControlName="password"
              autocomplete="current-password"
              placeholder="Enter your password"
            />
            @if (error()) {
              <div class="form-error" role="alert">{{ error() }}</div>
            }
            <button
              mat-flat-button
              color="primary"
              class="sign-in"
              type="submit"
              [disabled]="form.invalid || pending()"
            >
              {{ pending() ? 'Signing in…' : 'Sign in' }} <span aria-hidden="true">→</span>
            </button>
          </form>
          <div class="demo-users">
            <span>DEMO ACCOUNTS</span>
            <button type="button" (click)="useDemo('operator')">Operator</button>
            <button type="button" (click)="useDemo('viewer')">Viewer</button>
          </div>
          <div class="secure-note">
            <span>♧</span> Your session is secured with in-memory tokens.
          </div>
        </div>
      </div>
    </section>
  `,
  styles: [
    `
      :host {
        display: block;
        min-height: 100vh;
      }
      .login-page {
        min-height: 100vh;
        display: grid;
        grid-template-columns: 1fr 1fr;
        background: #fff;
      }
      .login-art {
        position: relative;
        overflow: hidden;
        padding: 38px 8.5%;
        color: #fff;
        background: linear-gradient(145deg, #102b27 0%, #174b3b 52%, #1d684d 100%);
        display: flex;
        flex-direction: column;
      }
      .login-brand,
      .mobile-brand {
        color: #fff;
        text-decoration: none;
        font-size: 19px;
        font-weight: 750;
        letter-spacing: -0.4px;
        display: flex;
        align-items: center;
        gap: 8px;
        z-index: 1;
      }
      .login-brand span:last-child,
      .mobile-brand span {
        color: #91c8ad;
        font-weight: 500;
      }
      .brand-glyph {
        color: #9bd5b5;
        font-size: 24px;
      }
      .art-copy {
        position: relative;
        z-index: 1;
        margin: auto 0;
        padding: 50px 0 42px;
      }
      .eyebrow {
        color: #a0d4b8;
        font-size: 10px;
        font-weight: 750;
        letter-spacing: 1.55px;
        display: flex;
        align-items: center;
        gap: 9px;
      }
      .pulse {
        width: 7px;
        height: 7px;
        background: #5de3a1;
        border-radius: 50%;
        box-shadow: 0 0 0 5px #5de3a126;
      }
      h1 {
        font-size: clamp(38px, 4.2vw, 62px);
        line-height: 1.08;
        letter-spacing: -2.7px;
        margin: 23px 0 17px;
        font-weight: 650;
      }
      .art-copy p {
        color: #b6cec4;
        font-size: 15px;
      }
      .art-stats {
        display: flex;
        gap: 65px;
        position: relative;
        z-index: 1;
        margin-bottom: 18px;
      }
      .art-stats div {
        display: grid;
        gap: 4px;
      }
      .art-stats strong {
        font-size: 20px;
      }
      .art-stats span {
        color: #adc3b9;
        font-size: 11px;
      }
      .decor-grid {
        position: absolute;
        width: 460px;
        height: 460px;
        right: -175px;
        top: 27%;
        opacity: 0.12;
        transform: rotate(18deg);
        background-image:
          linear-gradient(#c0e0d222 1px, transparent 1px),
          linear-gradient(90deg, #c0e0d222 1px, transparent 1px);
        background-size: 34px 34px;
        border: 1px solid #d5f0e229;
        border-radius: 50%;
        box-shadow:
          0 0 0 50px #d5f0e20d,
          0 0 0 100px #d5f0e20a;
      }
      .login-panel {
        display: grid;
        place-items: center;
        padding: 40px 8%;
      }
      .login-form-wrap {
        width: min(390px, 100%);
      }
      .dark {
        color: #2b8a64;
      }
      h2 {
        font-size: 27px;
        letter-spacing: -0.8px;
        margin: 14px 0 8px;
        color: #1e2b3b;
      }
      .form-intro {
        color: #8390a0;
        font-size: 13px;
        line-height: 1.6;
        margin: 0 0 30px;
      }
      label {
        display: block;
        font-size: 12px;
        color: #344254;
        font-weight: 650;
        margin: 18px 0 8px;
      }
      input {
        width: 100%;
        box-sizing: border-box;
        height: 46px;
        border: 1px solid #dce3eb;
        border-radius: 7px;
        padding: 0 13px;
        font: inherit;
        font-size: 13px;
        outline: none;
      }
      input:focus {
        border-color: #36956d;
        box-shadow: 0 0 0 3px #299c6b16;
      }
      .sign-in {
        width: 100%;
        height: 47px;
        margin-top: 24px;
        background: #1e7755 !important;
        color: white !important;
        border-radius: 7px !important;
        font-size: 13px;
        font-weight: 650;
      }
      .sign-in span {
        margin-left: 10px;
        font-size: 18px;
      }
      .sign-in:disabled {
        opacity: 0.55;
      }
      .form-error {
        background: #fff0ee;
        color: #af3e31;
        border-radius: 6px;
        padding: 10px 12px;
        margin-top: 13px;
        font-size: 12px;
      }
      .field-error {
        color: #af3e31;
        font-size: 11px;
      }
      .demo-users {
        display: flex;
        align-items: center;
        gap: 7px;
        margin-top: 23px;
      }
      .demo-users span {
        color: #95a0ad;
        font-size: 9px;
        font-weight: 750;
        letter-spacing: 0.8px;
        margin-right: auto;
      }
      .demo-users button {
        border: 1px solid #e4e9ef;
        color: #566477;
        background: #fff;
        border-radius: 5px;
        padding: 6px 9px;
        font-size: 10px;
        cursor: pointer;
      }
      .secure-note {
        border-top: 1px solid #edf0f4;
        margin-top: 32px;
        padding-top: 18px;
        text-align: center;
        color: #96a1af;
        font-size: 10px;
      }
      .mobile-brand {
        display: none;
        color: #1f7555;
        margin-bottom: 45px;
      }
      @media (max-width: 750px) {
        .login-page {
          grid-template-columns: 1fr;
        }
        .login-art {
          display: none;
        }
        .login-panel {
          min-height: 100vh;
          padding: 25px;
        }
        .mobile-brand {
          display: flex;
        }
      }
    `,
  ],
})
export class LoginComponent {
  private readonly fb = inject(FormBuilder);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  readonly pending = signal(false);
  readonly error = signal('');
  readonly form = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required, Validators.minLength(6)]],
  });

  useDemo(role: 'operator' | 'viewer'): void {
    this.form.setValue({
      email: role === 'operator' ? 'operator@pulse.dev' : 'viewer@pulse.dev',
      password: 'pulse123',
    });
  }

  submit(): void {
    if (this.form.invalid || this.pending()) return;
    this.pending.set(true);
    this.error.set('');
    this.auth.login(this.form.controls.email.value, this.form.controls.password.value).subscribe({
      next: () => void this.router.navigateByUrl(this.auth.takeReturnUrl()),
      error: (error: { error?: { error?: { message?: string } } }) => {
        this.error.set(
          error.error?.error?.message || 'Unable to sign in. Check your connection and try again.',
        );
        this.pending.set(false);
      },
      complete: () => this.pending.set(false),
    });
  }
}

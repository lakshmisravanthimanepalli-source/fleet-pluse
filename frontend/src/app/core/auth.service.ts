import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { Observable, Subject, catchError, map, of, tap, throwError } from 'rxjs';
import { APP_CONFIG } from './config';
import { TokenResponse, User } from './models';
import { SingleFlight } from './single-flight';

@Injectable({ providedIn: 'root' })
export class AuthService {
  readonly user = signal<User | null>(null);
  readonly accessToken = signal<string | null>(null);
  private refreshToken: string | null = null;
  private accessExpiresAt = 0;
  private readonly refreshFlight = new SingleFlight<TokenResponse>();
  private requestCancellation = new Subject<void>();
  private readonly logoutChannel =
    typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('fleet-pulse-auth');
  private returnUrl = '/';

  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);

  constructor() {
    this.logoutChannel?.addEventListener('message', (event: MessageEvent<{ type?: string }>) => {
      if (event.data?.type === 'logout' && this.user()) this.logout(false);
    });
  }

  login(email: string, password: string): Observable<TokenResponse> {
    return this.http
      .post<TokenResponse>(`${APP_CONFIG.apiUrl}/auth/login`, { email, password })
      .pipe(tap((tokens) => this.acceptTokens(tokens)));
  }

  refreshSingleFlight(): Observable<TokenResponse> {
    if (!this.refreshToken) {
      return throwError(() => new Error('No refresh token is available'));
    }
    return this.refreshFlight.run(() =>
      this.http
        .post<TokenResponse>(`${APP_CONFIG.apiUrl}/auth/refresh`, {
          refreshToken: this.refreshToken,
        })
        .pipe(tap((tokens) => this.acceptTokens(tokens))),
    );
  }

  ensureFreshAccessToken(): Observable<string> {
    const token = this.accessToken();
    if (!token) return throwError(() => new Error('No access token is available'));
    if (this.accessExpiresAt - Date.now() > 5_000) return of(token);
    return this.refreshSingleFlight().pipe(
      map((tokens) => tokens.accessToken),
      catchError((error: unknown) => {
        const attemptedUrl = this.router.url;
        this.logout();
        this.rememberReturnUrl(attemptedUrl);
        return throwError(() => error);
      }),
    );
  }

  get cancelProtectedRequests(): Observable<void> {
    return this.requestCancellation.asObservable();
  }

  rememberReturnUrl(url: string): void {
    this.returnUrl = url.startsWith('/') && !url.startsWith('//') ? url : '/';
  }

  takeReturnUrl(): string {
    const url = this.returnUrl;
    this.returnUrl = '/';
    return url;
  }

  logout(broadcast = true): void {
    if (!this.user() && !this.accessToken() && !this.refreshToken) return;
    if (broadcast) this.logoutChannel?.postMessage({ type: 'logout' });
    this.requestCancellation.next();
    this.requestCancellation.complete();
    this.requestCancellation = new Subject<void>();
    this.accessToken.set(null);
    this.refreshToken = null;
    this.accessExpiresAt = 0;
    this.user.set(null);
    this.refreshFlight.clear();
    void this.router.navigate(['/login']);
  }

  private acceptTokens(tokens: TokenResponse): void {
    if (!this.user()) this.requestCancellation = new Subject<void>();
    this.accessToken.set(tokens.accessToken);
    this.refreshToken = tokens.refreshToken;
    this.accessExpiresAt = Date.now() + tokens.expiresIn * 1000;
    this.user.set(tokens.user);
  }
}

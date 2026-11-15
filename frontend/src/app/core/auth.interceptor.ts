import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import {
  catchError,
  retry,
  switchMap,
  takeUntil,
  tap,
  TimeoutError,
  throwError,
  timeout,
} from 'rxjs';
import { APP_CONFIG } from './config';
import { AuthService } from './auth.service';
import { ApiErrorBody } from './models';
import { isRetryableGet } from './resilience';
import { CircuitBreaker } from './circuit-breaker';

function retryDelay(error: HttpErrorResponse, attempt: number) {
  const retryableStatus = isRetryableGet('GET', error.status);
  if (!retryableStatus) return throwError(() => error);
  const retryAfter = error.headers.get('Retry-After');
  const delayMs =
    error.status === 429 && retryAfter
      ? Math.max(0, Number(retryAfter) * 1000)
      : Math.min(250 * 2 ** (attempt - 1), 2_000);
  return new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

export const authInterceptor: HttpInterceptorFn = (request, next) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  const circuitBreaker = inject(CircuitBreaker);
  const isPublic =
    request.url.includes('/auth/') ||
    request.url.includes('/chaos') ||
    request.url.includes('/health');
  const token = auth.accessToken();
  const authenticatedRequest =
    !isPublic && token
      ? request.clone({ setHeaders: { Authorization: `Bearer ${token}` } })
      : request;
  const endpoint = new URL(request.url).pathname;
  const circuitRoute = request.method === 'GET' ? circuitBreaker.route(endpoint) : 'primary';
  let outboundRequest = authenticatedRequest;
  if (request.method === 'GET' && circuitRoute === 'secondary') {
    const secondaryUrl = new URL(authenticatedRequest.url);
    if (secondaryUrl.port === '4000') secondaryUrl.port = '4001';
    outboundRequest = authenticatedRequest.clone({ url: secondaryUrl.toString() });
  }
  const sentToPrimary = request.method === 'GET' && circuitRoute !== 'secondary';
  const attempts = request.method === 'GET' ? APP_CONFIG.maxGetRetries : 0;

  return next(outboundRequest).pipe(
    timeout({ first: APP_CONFIG.requestTimeoutMs }),
    retry({ count: attempts, delay: retryDelay }),
    tap({
      next: () => {
        if (sentToPrimary) circuitBreaker.recordSuccess(endpoint);
      },
    }),
    catchError((error: unknown) => {
      if (sentToPrimary) {
        if (error instanceof TimeoutError) circuitBreaker.recordFailure(endpoint);
        else if (
          error instanceof HttpErrorResponse &&
          [0, 429, 500, 502, 503, 504].includes(error.status)
        ) {
          circuitBreaker.recordFailure(endpoint);
        } else if (circuitRoute === 'trial') circuitBreaker.releaseTrial(endpoint);
      }
      if (
        error instanceof HttpErrorResponse &&
        error.status === 401 &&
        (error.error as ApiErrorBody | undefined)?.error?.code === 'token_expired' &&
        !isPublic
      ) {
        return auth.refreshSingleFlight().pipe(
          catchError((refreshError: unknown) => {
            auth.logout();
            const attemptedUrl = router.url;
            auth.rememberReturnUrl(attemptedUrl);
            return throwError(() => refreshError);
          }),
          switchMap((tokens) =>
            next(
              request.clone({ setHeaders: { Authorization: `Bearer ${tokens.accessToken}` } }),
            ).pipe(
              timeout({ first: APP_CONFIG.requestTimeoutMs }),
              tap(() => circuitBreaker.recordSuccess(endpoint)),
            ),
          ),
        );
      }
      return throwError(() => error);
    }),
    takeUntil(auth.cancelProtectedRequests),
  );
};

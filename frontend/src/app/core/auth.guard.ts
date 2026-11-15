import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from './auth.service';

export const authGuard: CanActivateFn = (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  if (auth.user()) return true;
  auth.rememberReturnUrl(state.url);
  return router.createUrlTree(['/login']);
};

export const operatorGuard: CanActivateFn = (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  if (!auth.user()) {
    auth.rememberReturnUrl(state.url);
    return router.createUrlTree(['/login']);
  }
  return auth.user()?.role === 'operator' ? true : router.createUrlTree(['/']);
};

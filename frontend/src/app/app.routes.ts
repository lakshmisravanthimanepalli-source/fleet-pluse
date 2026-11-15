import { Routes } from '@angular/router';
import { authGuard, operatorGuard } from './core/auth.guard';
import { unsavedChangesGuard } from './features/rules/unsaved-changes.guard';

export const routes: Routes = [
  {
    path: 'login',
    loadComponent: () => import('./features/login/login.component').then((m) => m.LoginComponent),
  },
  {
    path: '',
    canActivate: [authGuard],
    loadComponent: () => import('./features/fleet/fleet.component').then((m) => m.FleetComponent),
  },
  {
    path: 'services/:id',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./features/service-detail/service-detail.component').then(
        (m) => m.ServiceDetailComponent,
      ),
  },
  {
    path: 'rules',
    canActivate: [operatorGuard],
    canDeactivate: [unsavedChangesGuard],
    loadComponent: () => import('./features/rules/rules.component').then((m) => m.RulesComponent),
  },
  {
    path: 'settings',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./features/settings/settings.component').then((m) => m.SettingsComponent),
  },
  { path: '**', redirectTo: '' },
];

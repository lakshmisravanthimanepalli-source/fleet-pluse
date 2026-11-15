import { CanDeactivateFn } from '@angular/router';
import { RulesComponent } from './rules.component';

export const unsavedChangesGuard: CanDeactivateFn<RulesComponent> = (component) =>
  component.canLeave();

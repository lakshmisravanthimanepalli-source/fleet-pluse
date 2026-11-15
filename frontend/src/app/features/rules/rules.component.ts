import { Component, effect, inject, signal } from '@angular/core';
import {
  AbstractControl,
  AsyncValidatorFn,
  FormArray,
  FormBuilder,
  FormGroup,
  ReactiveFormsModule,
  ValidationErrors,
  Validators,
} from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { MatIconModule } from '@angular/material/icon';
import { catchError, map, of, switchMap, timer } from 'rxjs';
import { AlertRule, MetricEvent, MetricName, RuleCondition, RuleOperator } from '../../core/models';
import { RulesService } from '../../core/rules.service';
import { MetricsService } from '../../core/metrics.service';
import { isThresholdValid, isValidDuration, thresholdsOrdered } from '../../core/resilience';
import { RuleEvaluator } from '../../core/rule-evaluator';

function thresholdRange(control: AbstractControl): ValidationErrors | null {
  const metric = control.parent?.get('metric')?.value as MetricName | undefined;
  const value = Number(control.value);
  if (isThresholdValid(metric || 'p95', value)) return null;
  if (!Number.isFinite(value)) return { thresholdRequired: true };
  if (metric === 'errRate') return { percentageRange: true };
  if (metric === 'p95') return { positiveLatency: true };
  return { nonNegativeRate: true };
}

function positiveDuration(control: AbstractControl): ValidationErrors | null {
  return isValidDuration(Number(control.value)) ? null : { invalidDuration: true };
}

function thresholdOrdering(control: AbstractControl): ValidationErrors | null {
  const warning = Number(control.get('threshold')?.value);
  const critical = Number(control.get('criticalThreshold')?.value);
  const operator = String(control.get('operator')?.value || '>');
  return thresholdsOrdered(warning, critical, operator) ? null : { thresholdOrder: true };
}

@Component({
  standalone: true,
  imports: [ReactiveFormsModule, MatIconModule],
  template: `
    <div class="page-head">
      <div>
        <div class="crumb">OPERATIONS <span>/</span> CONFIGURATION</div>
        <h1>Alert rules</h1>
        <p>Create thresholds that watch your live stream and surface incidents.</p>
      </div>
      <div class="rule-count">
        <mat-icon>notifications_active</mat-icon> {{ rules().length }} rules active
      </div>
    </div>
    <div class="rules-layout">
      <section class="rule-list card">
        <div class="section-head">
          <div>
            <h2>Configured rules</h2>
            <p>Evaluated in your browser against live metrics.</p>
          </div>
          <button class="primary-button" (click)="newRule()">＋ New rule</button>
        </div>
        @if (loadError()) {
          <div class="inline-error" role="alert">{{ loadError() }}</div>
        }
        @if (draftAvailable()) {
          <div class="draft-banner">
            <span>A saved rule draft is available from this browser.</span
            ><button type="button" (click)="restoreDraft()">Restore draft</button>
          </div>
        }
        @if (rules().length === 0) {
          <div class="empty-rules">
            <mat-icon>notifications_none</mat-icon><strong>No alert rules yet</strong
            ><span>Create your first rule to monitor live metrics.</span>
          </div>
        }
        @for (rule of rules(); track rule.id) {
          <article class="rule-row">
            <div class="rule-icon"><mat-icon>notifications</mat-icon></div>
            <div class="rule-info">
              <strong>{{ rule.name }}</strong><span
                >{{ describe(rule.conditions[0]) }}
                @if (rule.conditions.length > 1) {
                  <em>+{{ rule.conditions.length - 1 }} more</em>
                }</span
              ><small
                >{{ rule.conditions.length }}
                {{ rule.conditions.length === 1 ? 'condition' : 'conditions' }} · updated
                {{ dateLabel(rule.updatedAt) }}</small
              >
            </div>
            <span class="rule-state"><i></i> ACTIVE</span>
            <button class="icon-button" aria-label="Edit rule" (click)="editRule(rule)">
              <mat-icon>edit</mat-icon>
            </button>
            <button class="icon-button danger" aria-label="Delete rule" (click)="deleteRule(rule)">
              <mat-icon>delete_outline</mat-icon>
            </button>
          </article>
        }
      </section>
      <aside class="incident-card card">
        <div class="section-head">
          <div>
            <h2>Incident panel</h2>
            <p>Triggered by live data</p>
          </div>
          <span class="incident-number">{{ incidents().length }}</span>
        </div>
        @if (!incidents().length) {
          <div class="empty-incidents">
            <span class="check-ring">✓</span><strong>All quiet</strong
            ><span>No active incidents detected.</span>
          </div>
        }
        @for (incident of incidents(); track incident.key) {
          <div class="incident">
            <span class="incident-dot"></span>
            <div>
              <strong>{{ incident.name }}</strong><span
                >{{ incident.serviceId }} · {{ incident.detail }}</span
              ><small>{{ dateLabel(incident.ts) }}</small>
            </div>
          </div>
        }
        <div class="incident-foot">
          <span class="live-pip"></span> Monitoring {{ metrics.services().length }} services
        </div>
      </aside>
    </div>
    @if (editing()) {
      <div
        class="modal-backdrop"
        role="presentation"
        tabindex="-1"
        (click)="backdrop($event)"
        (keydown.escape)="closeForm()"
      >
        <section class="rule-modal" role="dialog" aria-modal="true" aria-labelledby="form-title">
          <div class="modal-head">
            <div>
              <div class="crumb">RULE CONFIGURATION</div>
              <h2 id="form-title">{{ editingId() ? 'Edit alert rule' : 'Create alert rule' }}</h2>
            </div>
            <button class="icon-button" aria-label="Close dialog" (click)="closeForm()">
              <mat-icon>close</mat-icon>
            </button>
          </div>
          <form [formGroup]="form" (ngSubmit)="save()">
            <label for="rule-name">Rule name</label>
            <input id="rule-name" formControlName="name" placeholder="e.g. Checkout latency" />
            @if (nameControl.invalid && nameControl.touched) {
              <span class="validation-error">{{
                nameControl.errors?.['required']
                  ? 'Enter a rule name.'
                  : nameControl.errors?.['nameTaken']
                    ? 'A rule with this name already exists.'
                    : nameControl.errors?.['nameCheckUnavailable']
                      ? 'Could not verify the name. Check your connection.'
                      : 'Rule names must be at least 3 characters.'
              }}</span>
            }
            <div class="conditions-header">
              <div>
                <h3>Conditions</h3>
                <span>Every condition is evaluated against each service.</span>
              </div>
              <button type="button" class="text-button" (click)="addCondition()">
                ＋ Add condition
              </button>
            </div>
            <div formArrayName="conditions" class="condition-list">
              @for (condition of conditions.controls; track condition; let i = $index) {
                <div class="condition-card" [formGroupName]="i">
                  <div class="condition-top">
                    <strong>Condition {{ i + 1 }}</strong>
                    @if (conditions.length > 1) {
                      <button type="button" class="remove-button" (click)="removeCondition(i)">
                        Remove
                      </button>
                    }
                  </div>
                  <div class="field-grid">
                    <label
                      >Metric<select
                        formControlName="metric"
                        (change)="condition.get('threshold')?.updateValueAndValidity()"
                      >
                        <option value="p95">P95 latency (ms)</option>
                        <option value="errRate">Error rate (%)</option>
                        <option value="rps">Requests / sec</option>
                      </select></label
                    >
                    <label
                      >Operator<select formControlName="operator">
                        <option value=">">Greater than</option>
                        <option value=">=">At least</option>
                        <option value="<">Less than</option>
                        <option value="<=">At most</option>
                      </select></label
                    >
                    <label
                      >Warning threshold<input type="number" formControlName="threshold" min="0"
                    /></label>
                    <label
                      >Critical threshold<input
                        type="number"
                        formControlName="criticalThreshold"
                        min="0"
                    /></label>
                    <label
                      >Duration (seconds)<input type="number" formControlName="durationSec" min="0"
                    /></label>
                  </div>
                  @if (condition.errors?.['thresholdOrder']) {
                    <span class="validation-error"
                      >Critical threshold must be
                      {{
                        condition.get('operator')?.value === '<' ||
                        condition.get('operator')?.value === '<='
                          ? 'lower'
                          : 'greater'
                      }}
                      than the warning threshold.</span
                    >
                  }
                  @if (condition.get('threshold')?.errors?.['percentageRange']) {
                    <span class="validation-error">Error rate must be between 0 and 100%.</span>
                  }
                  @if (condition.get('threshold')?.errors?.['positiveLatency']) {
                    <span class="validation-error"
                      >Latency threshold must be greater than zero.</span
                    >
                  }
                  @if (condition.get('durationSec')?.errors?.['invalidDuration']) {
                    <span class="validation-error">Duration must be a non-negative number.</span>
                  }
                </div>
              }
            </div>
            @if (saveError()) {
              <div class="inline-error" role="alert">{{ saveError() }}</div>
            }
            <div class="modal-actions">
              <button type="button" class="cancel-button" (click)="closeForm()">Cancel</button
              ><button type="submit" class="primary-button" [disabled]="saving() || form.pending">
                {{ saving() ? 'Saving…' : 'Save rule' }}
              </button>
            </div>
          </form>
        </section>
      </div>
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .page-head {
        display: flex;
        justify-content: space-between;
        align-items: flex-end;
        margin: 4px 0 24px;
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
      .rule-count {
        display: flex;
        align-items: center;
        gap: 7px;
        background: #edf6f0;
        color: #317c59;
        padding: 8px 11px;
        border-radius: 6px;
        font-size: 10px;
      }
      .rule-count mat-icon {
        font-size: 16px;
        width: 16px;
        height: 16px;
      }
      .rules-layout {
        display: grid;
        grid-template-columns: minmax(0, 1.8fr) minmax(255px, 0.9fr);
        gap: 16px;
        align-items: start;
      }
      .card {
        background: #fff;
        border: 1px solid #e8edf2;
        border-radius: 9px;
      }
      .section-head {
        padding: 17px 18px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        border-bottom: 1px solid #eff2f5;
      }
      .section-head h2 {
        margin: 0;
        color: #2c3a4b;
        font-size: 13px;
      }
      .section-head p {
        margin: 5px 0 0;
        color: #97a2ae;
        font-size: 10px;
      }
      .primary-button {
        background: #1e7855;
        color: #fff;
        border: 0;
        border-radius: 6px;
        padding: 9px 13px;
        font-size: 10px;
        font-weight: 650;
        cursor: pointer;
      }
      .primary-button:hover {
        background: #176747;
      }
      .primary-button:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
      .rule-row {
        min-height: 77px;
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 11px 17px;
        border-bottom: 1px solid #f0f2f5;
      }
      .rule-row:last-child {
        border-bottom: 0;
      }
      .rule-icon {
        width: 32px;
        height: 32px;
        display: grid;
        place-items: center;
        border-radius: 8px;
        background: #f1f3fc;
        color: #7786bd;
      }
      .rule-icon mat-icon {
        font-size: 17px;
        width: 17px;
        height: 17px;
      }
      .rule-info {
        flex: 1;
        min-width: 0;
      }
      .rule-info strong,
      .rule-info span,
      .rule-info small {
        display: block;
      }
      .rule-info strong {
        color: #344256;
        font-size: 11px;
      }
      .rule-info span {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        margin-top: 4px;
        color: #788698;
        font-size: 10px;
      }
      .rule-info em {
        color: #428263;
        font-style: normal;
      }
      .rule-info small {
        margin-top: 4px;
        color: #a1aab5;
        font-size: 9px;
      }
      .rule-state {
        display: flex;
        align-items: center;
        gap: 6px;
        color: #428265;
        font-size: 8px;
        font-weight: 700;
      }
      .rule-state i,
      .live-pip {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: #34a477;
      }
      .icon-button {
        width: 28px;
        height: 28px;
        display: grid;
        place-items: center;
        border: 0;
        background: transparent;
        color: #8995a2;
        cursor: pointer;
        border-radius: 5px;
      }
      .icon-button:hover {
        background: #f1f4f6;
      }
      .icon-button.danger:hover {
        color: #c34840;
        background: #fff1ef;
      }
      .icon-button mat-icon {
        font-size: 17px;
        width: 17px;
        height: 17px;
      }
      .incident-number {
        min-width: 22px;
        height: 22px;
        display: grid;
        place-items: center;
        background: #f0f3f6;
        color: #768395;
        border-radius: 50%;
        font-size: 10px;
      }
      .empty-rules,
      .empty-incidents {
        display: flex;
        align-items: center;
        flex-direction: column;
        justify-content: center;
        padding: 44px 15px;
        color: #a1abb6;
      }
      .empty-rules mat-icon {
        font-size: 27px;
        width: 27px;
        height: 27px;
        margin-bottom: 9px;
      }
      .empty-rules strong,
      .empty-incidents strong {
        color: #647284;
        font-size: 11px;
      }
      .empty-rules span,
      .empty-incidents span:not(.check-ring) {
        margin-top: 6px;
        font-size: 10px;
      }
      .draft-banner {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin: 12px;
        padding: 10px;
        border: 1px solid #e8dcc0;
        border-radius: 6px;
        background: #fff9eb;
        color: #876b35;
        font-size: 10px;
      }
      .draft-banner button {
        border: 0;
        background: transparent;
        color: #327b5b;
        font-weight: 650;
        font-size: 10px;
        cursor: pointer;
      }
      .empty-incidents {
        padding: 37px 12px;
      }
      .check-ring {
        width: 34px;
        height: 34px;
        border-radius: 50%;
        display: grid;
        place-items: center;
        background: #e9f5ee;
        color: #36815e;
        font-weight: 700;
        margin-bottom: 11px;
      }
      .incident {
        display: flex;
        gap: 10px;
        padding: 12px 15px;
        border-bottom: 1px solid #f0f2f5;
      }
      .incident-dot {
        width: 7px;
        height: 7px;
        flex: none;
        margin-top: 5px;
        border-radius: 50%;
        background: #d9764d;
      }
      .incident strong,
      .incident span,
      .incident small {
        display: block;
      }
      .incident strong {
        font-size: 10px;
        color: #39475a;
      }
      .incident span {
        margin-top: 4px;
        color: #7c8998;
        font-size: 9px;
      }
      .incident small {
        margin-top: 4px;
        color: #a1abb5;
        font-size: 8px;
      }
      .incident-foot {
        display: flex;
        align-items: center;
        gap: 7px;
        padding: 12px 15px;
        color: #7e8d9a;
        font-size: 9px;
      }
      .inline-error {
        margin: 12px;
        padding: 10px;
        border-radius: 5px;
        background: #fff0ee;
        color: #ad453c;
        font-size: 10px;
      }
      .modal-backdrop {
        position: fixed;
        inset: 0;
        z-index: 10;
        background: #15253666;
        display: grid;
        place-items: center;
        padding: 20px;
      }
      .rule-modal {
        background: #fff;
        border-radius: 10px;
        width: min(650px, 100%);
        max-height: 90vh;
        overflow: auto;
        box-shadow: 0 20px 70px #14263a38;
      }
      .modal-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 19px 22px;
        border-bottom: 1px solid #edf0f3;
      }
      .modal-head h2 {
        margin: 7px 0 0;
        font-size: 17px;
        color: #26364a;
      }
      form {
        padding: 18px 22px;
      }
      .rule-modal label {
        display: grid;
        gap: 6px;
        color: #657386;
        font-size: 10px;
        font-weight: 600;
      }
      .rule-modal input,
      .rule-modal select {
        height: 34px;
        box-sizing: border-box;
        border: 1px solid #dfe5eb;
        border-radius: 5px;
        padding: 0 9px;
        color: #334255;
        background: white;
        font: inherit;
        font-size: 10px;
        outline: none;
      }
      .rule-modal input:focus,
      .rule-modal select:focus {
        border-color: #378b66;
        box-shadow: 0 0 0 2px #378b661a;
      }
      .conditions-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin: 23px 0 10px;
      }
      .conditions-header h3 {
        margin: 0;
        color: #344255;
        font-size: 11px;
      }
      .conditions-header span {
        display: block;
        margin-top: 4px;
        color: #98a3ae;
        font-size: 9px;
      }
      .text-button,
      .remove-button {
        border: 0;
        background: none;
        color: #327b5b;
        font-size: 10px;
        cursor: pointer;
      }
      .condition-list {
        display: grid;
        gap: 9px;
      }
      .condition-card {
        border: 1px solid #e9edf1;
        background: #fbfcfd;
        border-radius: 7px;
        padding: 12px;
      }
      .condition-top {
        display: flex;
        justify-content: space-between;
        margin-bottom: 11px;
      }
      .condition-top strong {
        font-size: 10px;
        color: #455367;
      }
      .remove-button {
        color: #b45b50;
        font-size: 9px;
      }
      .field-grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 11px;
      }
      .validation-error {
        display: block;
        margin-top: 6px;
        color: #b54c43;
        font-size: 9px;
      }
      .modal-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 20px;
        padding-top: 14px;
        border-top: 1px solid #edf0f3;
      }
      .cancel-button {
        border: 1px solid #e0e5eb;
        background: #fff;
        color: #657386;
        border-radius: 6px;
        padding: 8px 13px;
        font-size: 10px;
        cursor: pointer;
      }
      @media (max-width: 850px) {
        .rules-layout {
          grid-template-columns: 1fr;
        }
        .page-head {
          align-items: flex-start;
          gap: 12px;
          flex-direction: column;
        }
      }
      @media (max-width: 540px) {
        .field-grid {
          grid-template-columns: repeat(2, 1fr);
        }
      }
    `,
  ],
})
export class RulesComponent {
  private readonly fb = inject(FormBuilder);
  private readonly api = inject(RulesService);
  readonly metrics = inject(MetricsService);
  readonly rules = signal<AlertRule[]>([]);
  readonly incidents = signal<
    { key: string; name: string; serviceId: string; detail: string; ts: number }[]
  >([]);
  readonly editing = signal(false);
  readonly editingId = signal<string | null>(null);
  readonly saving = signal(false);
  readonly saveError = signal('');
  readonly loadError = signal('');
  readonly draftAvailable = signal(false);
  private readonly evaluator = new RuleEvaluator();
  readonly form = this.fb.group({
    name: this.fb.nonNullable.control('', {
      validators: [Validators.required, Validators.minLength(3)],
      asyncValidators: [this.uniqueNameValidator()],
      updateOn: 'change',
    }),
    conditions: this.fb.array([this.conditionGroup()]),
  });

  constructor() {
    try {
      this.draftAvailable.set(Boolean(localStorage.getItem('fleet-pulse-rule-draft')));
    } catch (error) {
      console.warn('Unable to access saved rule drafts', error);
    }
    this.loadRules();
    this.form.valueChanges.subscribe(() => {
      if (!this.editing()) return;
      try {
        localStorage.setItem(
          'fleet-pulse-rule-draft',
          JSON.stringify({
            id: this.editingId(),
            value: this.form.getRawValue(),
            savedAt: Date.now(),
          }),
        );
        this.draftAvailable.set(true);
      } catch (error) {
        console.warn('Unable to save the rule draft', error);
      }
    });
    effect(() => {
      const event = this.metrics.lastMetricEvent();
      if (event) this.evaluate(event);
    });
  }

  get conditions(): FormArray {
    return this.form.controls.conditions;
  }

  get nameControl() {
    return this.form.controls.name;
  }

  canLeave(): boolean {
    return (
      !this.editing() ||
      !this.form.dirty ||
      window.confirm('You have unsaved changes. Leave without saving?')
    );
  }

  newRule(): void {
    this.editingId.set(null);
    this.resetForm();
    this.editing.set(true);
  }

  editRule(rule: AlertRule): void {
    this.editingId.set(rule.id);
    this.resetForm(rule);
    this.editing.set(true);
  }

  addCondition(): void {
    this.conditions.push(this.conditionGroup());
    this.form.markAsDirty();
  }

  restoreDraft(): void {
    try {
      const saved = localStorage.getItem('fleet-pulse-rule-draft');
      if (!saved) return this.draftAvailable.set(false);
      const draft = JSON.parse(saved) as {
        id?: string | null;
        value?: { name?: string; conditions?: RuleCondition[] };
      };
      if (typeof draft.value?.name !== 'string' || !Array.isArray(draft.value.conditions)) {
        this.draftAvailable.set(false);
        localStorage.removeItem('fleet-pulse-rule-draft');
        return;
      }
      const original = draft.id ? this.rules().find((rule) => rule.id === draft.id) : undefined;
      this.resetForm({
        id: original?.id || '',
        name: draft.value.name,
        conditions: draft.value.conditions,
        createdAt: original?.createdAt || Date.now(),
        updatedAt: original?.updatedAt || Date.now(),
      });
      this.editingId.set(original?.id || null);
      this.form.markAsDirty();
      this.editing.set(true);
      this.draftAvailable.set(false);
    } catch (error) {
      console.warn('Unable to restore the saved rule draft', error);
      this.loadError.set('The saved rule draft could not be restored.');
      this.draftAvailable.set(false);
    }
  }

  removeCondition(index: number): void {
    if (this.conditions.length > 1) {
      this.conditions.removeAt(index);
      this.form.markAsDirty();
    }
  }

  closeForm(): void {
    if (!this.canLeave()) return;
    this.editing.set(false);
    this.saveError.set('');
  }

  backdrop(event: MouseEvent): void {
    if (event.target === event.currentTarget) this.closeForm();
  }

  save(): void {
    this.form.markAllAsTouched();
    if (this.form.invalid || this.form.pending || this.saving()) return;
    const raw = this.form.getRawValue();
    const payload = {
      name: raw.name.trim(),
      conditions: raw.conditions.map((condition) => ({
        metric: condition['metric'] as MetricName,
        operator: condition['operator'] as RuleOperator,
        threshold: Number(condition['threshold']),
        criticalThreshold: Number(condition['criticalThreshold']),
        durationSec: Number(condition['durationSec']),
      })),
    };
    const id = this.editingId();
    const previousRules = this.rules();
    this.saving.set(true);
    this.saveError.set('');
    if (id) {
      this.rules.update((current) =>
        current.map((rule) =>
          rule.id === id ? { ...rule, ...payload, updatedAt: Date.now() } : rule,
        ),
      );
      this.api.update({ ...previousRules.find((rule) => rule.id === id)!, ...payload }).subscribe({
        next: () => this.finishSave(),
        error: (error: unknown) => this.failSave(error, previousRules),
      });
    } else {
      const temporary: AlertRule = {
        ...payload,
        id: `pending-${Date.now()}`,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      this.rules.update((current) => [temporary, ...current]);
      this.api.create(payload).subscribe({
        next: (saved) => {
          this.rules.update((current) => [
            saved,
            ...current.filter((rule) => rule.id !== temporary.id),
          ]);
          this.finishSave();
        },
        error: (error: unknown) => this.failSave(error, previousRules),
      });
    }
  }

  deleteRule(rule: AlertRule): void {
    if (!window.confirm(`Delete "${rule.name}"?`)) return;
    const previous = this.rules();
    this.rules.update((current) => current.filter((item) => item.id !== rule.id));
    this.api.delete(rule.id).subscribe({
      error: (error: unknown) => {
        this.rules.set(previous);
        this.loadError.set(this.errorMessage(error));
      },
    });
  }

  describe(condition: RuleCondition): string {
    const unit = condition.metric === 'p95' ? 'ms' : condition.metric === 'errRate' ? '%' : 'req/s';
    return `${condition.metric} ${condition.operator} ${condition.threshold}${unit}`;
  }

  dateLabel(timestamp: number): string {
    return new Date(timestamp).toLocaleString();
  }

  private uniqueNameValidator(): AsyncValidatorFn {
    return (control: AbstractControl) => {
      const name = String(control.value || '').trim();
      if (name.length < 3) return of(null);
      return timer(300).pipe(
        switchMap(() => this.api.checkName(name, this.editingId() || undefined)),
        map((response) => (response.available ? null : { nameTaken: true })),
        catchError(() => of({ nameCheckUnavailable: true })),
      );
    };
  }

  private conditionGroup(condition?: RuleCondition): FormGroup {
    const group = this.fb.group(
      {
        metric: this.fb.nonNullable.control<MetricName>(condition?.metric || 'p95'),
        operator: this.fb.nonNullable.control<RuleOperator>(condition?.operator || '>'),
        threshold: this.fb.nonNullable.control(condition?.threshold ?? 500, [
          Validators.required,
          thresholdRange,
        ]),
        criticalThreshold: this.fb.nonNullable.control(condition?.criticalThreshold ?? 800, [
          Validators.required,
          thresholdRange,
        ]),
        durationSec: this.fb.nonNullable.control(condition?.durationSec ?? 30, [
          Validators.required,
          positiveDuration,
        ]),
      },
      { validators: [thresholdOrdering] },
    );
    group.controls.metric.valueChanges.subscribe(() =>
      group.controls.threshold.updateValueAndValidity(),
    );
    return group;
  }

  private resetForm(rule?: AlertRule): void {
    while (this.conditions.length) this.conditions.removeAt(0);
    if (rule) {
      this.form.controls.name.setValue(rule.name);
      for (const condition of rule.conditions) this.conditions.push(this.conditionGroup(condition));
    } else {
      this.form.controls.name.setValue('');
      this.conditions.push(this.conditionGroup());
    }
    this.form.markAsPristine();
    this.form.markAsUntouched();
    this.nameControl.updateValueAndValidity();
    this.saveError.set('');
  }

  private loadRules(): void {
    this.api.list().subscribe({
      next: (rules) => this.rules.set(rules),
      error: (error: unknown) => this.loadError.set(this.errorMessage(error)),
    });
  }

  private finishSave(): void {
    this.saving.set(false);
    this.editing.set(false);
    this.editingId.set(null);
    this.form.markAsPristine();
    try {
      localStorage.removeItem('fleet-pulse-rule-draft');
      this.draftAvailable.set(false);
    } catch (error) {
      console.warn('Unable to remove the saved rule draft', error);
    }
  }

  private failSave(error: unknown, previous: AlertRule[]): void {
    this.rules.set(previous);
    this.saving.set(false);
    this.saveError.set(this.errorMessage(error));
  }

  private evaluate(event: MetricEvent): void {
    for (const fired of this.evaluator.evaluate(this.rules(), event)) {
      const severity = fired.critical ? 'Critical' : 'Warning';
      const incident = {
        key: fired.key,
        name: `${severity}: ${fired.ruleName}`,
        serviceId: fired.serviceId,
        detail: `${fired.metric} is ${fired.value} (threshold ${fired.threshold})`,
        ts: fired.timestamp,
      };
      this.incidents.update((items) => [incident, ...items].slice(0, 50));
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        new Notification(incident.name, { body: `${fired.serviceId}: ${incident.detail}` });
      }
    }
  }

  private errorMessage(error: unknown): string {
    if (error instanceof HttpErrorResponse)
      return error.error?.error?.message || `Request failed (${error.status}).`;
    return 'Request failed. Check your connection and try again.';
  }
}

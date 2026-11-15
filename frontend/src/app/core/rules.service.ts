import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { APP_CONFIG } from './config';
import { AlertRule } from './models';

@Injectable({ providedIn: 'root' })
export class RulesService {
  private readonly http = inject(HttpClient);

  list(): Observable<AlertRule[]> {
    return this.http.get<AlertRule[]>(`${APP_CONFIG.apiUrl}/rules`);
  }

  checkName(name: string, excludeId?: string): Observable<{ available: boolean }> {
    const params: Record<string, string> = { name };
    if (excludeId) params['excludeId'] = excludeId;
    return this.http.get<{ available: boolean }>(`${APP_CONFIG.apiUrl}/rules/check-name`, {
      params,
    });
  }

  create(rule: Omit<AlertRule, 'id' | 'createdAt' | 'updatedAt'>): Observable<AlertRule> {
    return this.http.post<AlertRule>(`${APP_CONFIG.apiUrl}/rules`, rule, {
      headers: { 'Idempotency-Key': crypto.randomUUID() },
    });
  }

  update(rule: AlertRule): Observable<AlertRule> {
    return this.http.put<AlertRule>(`${APP_CONFIG.apiUrl}/rules/${rule.id}`, rule);
  }

  delete(id: string): Observable<void> {
    return this.http.delete<void>(`${APP_CONFIG.apiUrl}/rules/${id}`);
  }
}

import { AlertRule, MetricEvent } from './models';
import { conditionMatches } from './resilience';

export interface FiredCondition {
  key: string;
  ruleName: string;
  serviceId: string;
  metric: string;
  value: number;
  threshold: number;
  critical: boolean;
  timestamp: number;
}

export class RuleEvaluator {
  private readonly started = new Map<string, number>();
  private readonly fired = new Set<string>();

  evaluate(rules: AlertRule[], event: MetricEvent): FiredCondition[] {
    const incidents: FiredCondition[] = [];
    for (const rule of rules) {
      rule.conditions.forEach((condition, index) => {
        const key = `${rule.id}:${event.serviceId}:${index}`;
        const value = event[condition.metric];
        if (!conditionMatches(value, condition.operator, condition.threshold)) {
          this.started.delete(key);
          return;
        }
        const start = this.started.get(key) ?? event.ts;
        this.started.set(key, start);
        if (event.ts - start < condition.durationSec * 1000 || this.fired.has(key)) return;
        this.fired.add(key);
        incidents.push({
          key,
          ruleName: rule.name,
          serviceId: event.serviceId,
          metric: condition.metric,
          value,
          threshold: condition.threshold,
          critical:
            condition.criticalThreshold !== undefined &&
            conditionMatches(value, condition.operator, condition.criticalThreshold),
          timestamp: event.ts,
        });
      });
    }
    return incidents;
  }
}

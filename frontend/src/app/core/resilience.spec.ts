import { describe, expect, it } from 'vitest';
import { Subject } from 'rxjs';
import { MetricEvent } from './models';
import {
  conditionMatches,
  downsamplePoints,
  isRetryableGet,
  isThresholdValid,
  isValidDuration,
  isValidMetricEvent,
  nextTransport,
  orderUniqueEvents,
  reconnectDelayMs,
  thresholdsOrdered,
} from './resilience';
import { SingleFlight } from './single-flight';
import { CircuitBreaker } from './circuit-breaker';
import { RuleEvaluator } from './rule-evaluator';

function event(offset: number, serviceId = 'svc-0001', seq = offset): MetricEvent {
  return {
    type: 'metric',
    offset,
    serviceId,
    seq,
    ts: offset * 1000,
    p95: 120,
    errRate: 0.5,
    rps: 250,
    status: 'healthy',
  };
}

describe('stream recovery helpers', () => {
  it('sorts late events and removes duplicate offsets and service sequences', () => {
    const ordered = orderUniqueEvents([event(3), event(1), event(2), event(2)], 0, new Map());
    expect(ordered.map((item) => item.offset)).toEqual([1, 2, 3]);
    expect(orderUniqueEvents([event(4, 'svc-0001', 2)], 3, new Map([['svc-0001', 3]]))).toEqual([]);
  });

  it('rejects malformed metric frames', () => {
    expect(isValidMetricEvent(event(1))).toBe(true);
    expect(isValidMetricEvent({ type: 'metric', offset: 1 } as Partial<MetricEvent>)).toBe(false);
  });

  it('falls back after three failures and applies capped jittered backoff', () => {
    expect(nextTransport('websocket', 2)).toBe('reconnecting');
    expect(nextTransport('websocket', 3)).toBe('sse');
    expect(nextTransport('sse', 3)).toBe('polling');
    expect(reconnectDelayMs(1, 0.5)).toBe(1000);
    expect(reconnectDelayMs(20, 0.5)).toBe(30_000);
    expect(reconnectDelayMs(1, 0)).toBe(800);
  });
});

describe('request, form, alert and chart helpers', () => {
  it('retries only GET network and selected server/rate-limit failures', () => {
    expect(isRetryableGet('GET', 0)).toBe(true);
    expect(isRetryableGet('GET', 429)).toBe(true);
    expect(isRetryableGet('GET', 503)).toBe(true);
    expect(isRetryableGet('GET', 500)).toBe(false);
    expect(isRetryableGet('GET', 401)).toBe(false);
    expect(isRetryableGet('POST', 503)).toBe(false);
  });

  it('validates metric-specific bounds and cross-field thresholds', () => {
    expect(isThresholdValid('errRate', 100)).toBe(true);
    expect(isThresholdValid('errRate', 101)).toBe(false);
    expect(isThresholdValid('p95', 0)).toBe(false);
    expect(isValidDuration(0)).toBe(true);
    expect(isValidDuration(-1)).toBe(false);
    expect(thresholdsOrdered(10, 11)).toBe(true);
    expect(thresholdsOrdered(11, 10)).toBe(false);
    expect(thresholdsOrdered(11, 10, '<')).toBe(true);
  });

  it('evaluates operators and reduces chart data to its configured limit', () => {
    expect(conditionMatches(11, '>', 10)).toBe(true);
    expect(conditionMatches(10, '>', 10)).toBe(false);
    const points = Array.from({ length: 901 }, (_, index) => ({
      ts: index,
      p95: index,
      errRate: 1,
      rps: 2,
    }));
    const reduced = downsamplePoints(points, 300);
    expect(reduced).toHaveLength(300);
    expect(reduced[0].ts).toBe(0);
    expect(reduced.at(-1)?.ts).toBeLessThan(901);
    expect(downsamplePoints(points.slice(0, 3), 300)).toHaveLength(3);
  });
});

describe('refresh single-flight', () => {
  it('shares one refresh result across ten simultaneous subscribers', () => {
    const flight = new SingleFlight<{ accessToken: string }>();
    const response = new Subject<{ accessToken: string }>();
    let calls = 0;
    const values: string[] = [];
    for (let index = 0; index < 10; index++) {
      flight
        .run(() => {
          calls++;
          return response;
        })
        .subscribe((token) => values.push(token.accessToken));
    }
    expect(calls).toBe(1);
    response.next({ accessToken: 'fresh-token' });
    response.complete();
    expect(values).toHaveLength(10);
    expect(values.every((value) => value === 'fresh-token')).toBe(true);
  });
});

describe('read circuit breaker', () => {
  it('opens after five failures, routes reads to the secondary, and allows one trial', () => {
    const breaker = new CircuitBreaker();
    for (let failure = 0; failure < 5; failure++)
      breaker.recordFailure('/services', 1000 + failure);
    expect(breaker.route('/services', 2000)).toBe('secondary');
    expect(breaker.route('/metrics/snapshot', 2000)).toBe('primary');
    expect(breaker.route('/services', 22_000)).toBe('trial');
    expect(breaker.route('/services', 22_001)).toBe('secondary');
    breaker.recordSuccess('/services');
    expect(breaker.route('/services', 22_002)).toBe('primary');
  });
});

describe('rule evaluation', () => {
  it('honors duration and never emits the same incident twice', () => {
    const evaluator = new RuleEvaluator();
    const rule = {
      id: 'r-1',
      name: 'Latency',
      createdAt: 0,
      updatedAt: 0,
      conditions: [
        {
          metric: 'p95' as const,
          operator: '>' as const,
          threshold: 100,
          criticalThreshold: 200,
          durationSec: 2,
        },
      ],
    };
    expect(evaluator.evaluate([rule], { ...event(1), ts: 1000, p95: 150 })).toHaveLength(0);
    expect(evaluator.evaluate([rule], { ...event(2), ts: 2000, p95: 150 })).toHaveLength(0);
    expect(evaluator.evaluate([rule], { ...event(3), ts: 3000, p95: 250 })).toMatchObject([
      { ruleName: 'Latency', critical: true, serviceId: 'svc-0001' },
    ]);
    expect(evaluator.evaluate([rule], { ...event(4), ts: 4000, p95: 250 })).toHaveLength(0);
  });
});

import { MetricEvent, MetricName, MetricPoint, Transport } from './models';

export function isRetryableGet(method: string, status: number): boolean {
  return method.toUpperCase() === 'GET' && [0, 429, 502, 503, 504].includes(status);
}

export function nextTransport(transport: 'websocket' | 'sse', failures: number): Transport {
  if (transport === 'websocket' && failures >= 3) return 'sse';
  if (transport === 'sse' && failures >= 3) return 'polling';
  return 'reconnecting';
}

export function reconnectDelayMs(failures: number, random = 0.5): number {
  const base = Math.min(1000 * 2 ** Math.max(0, failures - 1), 30_000);
  return Math.round(base * (0.8 + random * 0.4));
}

export function isValidMetricEvent(event: unknown): event is MetricEvent {
  if (!event || typeof event !== 'object') return false;
  const metric = event as Record<string, unknown>;
  return (
    metric['type'] === 'metric' &&
    Number.isSafeInteger(metric['offset']) &&
    Number.isSafeInteger(metric['seq']) &&
    typeof metric['serviceId'] === 'string' &&
    Number.isFinite(metric['ts']) &&
    Number.isFinite(metric['p95']) &&
    Number.isFinite(metric['errRate']) &&
    Number.isFinite(metric['rps']) &&
    ['healthy', 'degraded', 'down'].includes(String(metric['status']))
  );
}

export function orderUniqueEvents(
  events: MetricEvent[],
  lastOffset: number,
  serviceSequences: ReadonlyMap<string, number>,
): MetricEvent[] {
  const seenOffsets = new Set<number>();
  const seenServiceSequences = new Map(serviceSequences);
  return events
    .slice()
    .sort((left, right) => left.offset - right.offset)
    .filter((event) => {
      if (event.offset <= lastOffset || seenOffsets.has(event.offset)) return false;
      const previousSequence = seenServiceSequences.get(event.serviceId) || 0;
      if (event.seq <= previousSequence) return false;
      seenOffsets.add(event.offset);
      seenServiceSequences.set(event.serviceId, event.seq);
      return true;
    });
}

export function downsamplePoints(points: MetricPoint[], limit: number): MetricPoint[] {
  if (limit < 1) return [];
  if (points.length <= limit) return points.slice();
  const step = points.length / limit;
  return Array.from({ length: limit }, (_, index) => points[Math.floor(index * step)]);
}

export function isThresholdValid(metric: MetricName, value: number): boolean {
  if (!Number.isFinite(value)) return false;
  if (metric === 'errRate') return value >= 0 && value <= 100;
  if (metric === 'p95') return value > 0;
  return value >= 0;
}

export function thresholdsOrdered(warning: number, critical: number, operator = '>'): boolean {
  if (!Number.isFinite(warning) || !Number.isFinite(critical)) return false;
  return operator === '<' || operator === '<=' ? critical < warning : critical > warning;
}

export function isValidDuration(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

export function conditionMatches(value: number, operator: string, threshold: number): boolean {
  switch (operator) {
    case '>':
      return value > threshold;
    case '>=':
      return value >= threshold;
    case '<':
      return value < threshold;
    case '<=':
      return value <= threshold;
    default:
      return false;
  }
}

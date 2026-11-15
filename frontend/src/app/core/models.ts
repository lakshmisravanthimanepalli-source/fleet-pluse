export type ServiceStatus = 'healthy' | 'degraded' | 'down';
export type MetricName = 'p95' | 'errRate' | 'rps';
export type RuleOperator = '>' | '>=' | '<' | '<=';
export type Transport = 'websocket' | 'sse' | 'polling' | 'reconnecting' | 'offline';

export interface User {
  id: string;
  email: string;
  role: 'viewer' | 'operator';
}

export interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: User;
}

export interface Service {
  id: string;
  name: string;
  team: string;
  status: ServiceStatus;
}

export interface MetricEvent {
  type: 'metric';
  offset: number;
  serviceId: string;
  seq: number;
  ts: number;
  p95: number;
  errRate: number;
  rps: number;
  status: ServiceStatus;
}

export interface MetricPoint {
  ts: number;
  p95: number;
  errRate: number;
  rps: number;
}

export interface MetricSnapshot {
  offset: number;
  ts: number;
  metrics: MetricEvent[];
}

export interface RuleCondition {
  metric: MetricName;
  operator: RuleOperator;
  threshold: number;
  durationSec: number;
  criticalThreshold?: number;
}

export interface AlertRule {
  id: string;
  name: string;
  conditions: RuleCondition[];
  createdAt: number;
  updatedAt: number;
}

export interface ApiErrorBody {
  error?: {
    code?: string;
    message?: string;
    details?: { field: string; message: string }[];
  };
}

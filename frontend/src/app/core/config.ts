export const APP_CONFIG = {
  apiUrl:
    (globalThis as typeof globalThis & { FLEET_API_URL?: string }).FLEET_API_URL ||
    'http://localhost:4000',
  requestTimeoutMs: 10_000,
  maxGetRetries: 2,
  reconnectBaseMs: 1_000,
  reconnectMaxMs: 30_000,
  wsConnectTimeoutMs: 5_000,
  heartbeatIntervalMs: 5_000,
  staleAfterMs: 10_000,
  chartPointLimit: 300,
  virtualItemSizePx: 52,
} as const;

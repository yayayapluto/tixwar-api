import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from 'prom-client';

export const registry = new Registry();

collectDefaultMetrics({ register: registry });

export const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['route', 'method', 'status'] as const,
  registers: [registry],
});

export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['route', 'method', 'status'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const cacheHitsTotal = new Counter({
  name: 'cache_hits_total',
  help: 'Cache hits',
  labelNames: ['cache'] as const,
  registers: [registry],
});

export const cacheMissesTotal = new Counter({
  name: 'cache_misses_total',
  help: 'Cache misses',
  labelNames: ['cache'] as const,
  registers: [registry],
});

export const cacheStaleServedTotal = new Counter({
  name: 'cache_stale_served_total',
  help: 'Stale cache entries served during stampede protection',
  labelNames: ['cache'] as const,
  registers: [registry],
});

export const rateLimitRejectedTotal = new Counter({
  name: 'rate_limit_rejected_total',
  help: 'Requests rejected by the rate limiter',
  labelNames: ['tier'] as const,
  registers: [registry],
});

export const rateLimitFallbackTotal = new Counter({
  name: 'rate_limit_fallback_total',
  help: 'Rate limiter calls served by the in-memory fallback',
  registers: [registry],
});

export const circuitBreakerState = new Gauge({
  name: 'circuit_breaker_state',
  help: 'Circuit breaker state (0=closed, 1=open, 2=half-open)',
  labelNames: ['name'] as const,
  registers: [registry],
});

export const circuitBreakerFailures = new Counter({
  name: 'circuit_breaker_failures_total',
  help: 'Circuit breaker recorded failures',
  labelNames: ['name'] as const,
  registers: [registry],
});

export const queueDepth = new Gauge({
  name: 'queue_depth',
  help: 'Queue depth (waiting + delayed + active jobs)',
  labelNames: ['queue'] as const,
  registers: [registry],
});

export const queueFailedTotal = new Counter({
  name: 'queue_failed_total',
  help: 'Queue jobs that failed',
  labelNames: ['queue'] as const,
  registers: [registry],
});

export const outboxPending = new Gauge({
  name: 'outbox_pending',
  help: 'Outbox events awaiting publication',
  registers: [registry],
});

export const outboxPublishTotal = new Counter({
  name: 'outbox_publish_total',
  help: 'Outbox events published',
  labelNames: ['type', 'result'] as const,
  registers: [registry],
});

export const ordersTotal = new Counter({
  name: 'orders_total',
  help: 'Orders by current status',
  labelNames: ['status'] as const,
  registers: [registry],
});

export const stockRemaining = new Gauge({
  name: 'stock_remaining',
  help: 'Remaining stock per tier in the Redis stock gate',
  labelNames: ['tier'] as const,
  registers: [registry],
});

export const mongodbOperationsTotal = new Counter({
  name: 'mongodb_operations_total',
  help: 'MongoDB commands executed by the driver',
  labelNames: ['collection', 'operation', 'result'] as const,
  registers: [registry],
});

export const mongodbOperationDuration = new Histogram({
  name: 'mongodb_operation_duration_seconds',
  help: 'MongoDB command duration in seconds',
  labelNames: ['collection', 'operation'] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [registry],
});

export const mongodbServerConnections = new Gauge({
  name: 'mongodb_server_connections',
  help: 'MongoDB server connections reported by serverStatus on mongos',
  labelNames: ['state'] as const,
  registers: [registry],
});

export const mongodbShardDocuments = new Gauge({
  name: 'mongodb_shard_documents',
  help: 'Documents per shard for sharded collections, from mongos $collStats',
  labelNames: ['collection', 'shard'] as const,
  registers: [registry],
});

export const replicaSetMemberState = new Gauge({
  name: 'mongodb_replica_member_state',
  help: 'Replica set member state from replSetGetStatus (1=primary, 2=secondary)',
  labelNames: ['set', 'member'] as const,
  registers: [registry],
});

export const replicaHealthGauge = new Gauge({
  name: 'mongodb_replica_healthy',
  help: 'Replica set has a healthy primary reachable through mongos (1/0)',
  labelNames: ['set'] as const,
  registers: [registry],
});

export const stockReconcileDrift = new Gauge({
  name: 'stock_reconcile_drift',
  help: 'Absolute drift between Redis stock gate and MongoDB durable stock',
  labelNames: ['tier'] as const,
  registers: [registry],
});

export const stockReconcileRuns = new Counter({
  name: 'stock_reconcile_runs_total',
  help: 'Stock reconciliation runs',
  labelNames: ['result'] as const,
  registers: [registry],
});

export const sseConnections = new Gauge({
  name: 'sse_connections',
  help: 'Active SSE connections',
  labelNames: ['channel'] as const,
  registers: [registry],
});

export const idempotencyOutcomes = new Counter({
  name: 'idempotency_outcomes_total',
  help: 'Idempotency key outcomes',
  labelNames: ['scope', 'outcome'] as const,
  registers: [registry],
});

export const stockGateOperations = new Counter({
  name: 'stock_gate_operations_total',
  help: 'Redis stock gate operations',
  labelNames: ['operation', 'result'] as const,
  registers: [registry],
});

export const traceEventsTotal = new Counter({
  name: 'trace_events_total',
  help: 'Trace events emitted to the Redis trace channel',
  labelNames: ['step', 'status'] as const,
  registers: [registry],
});

export const metrics = {
  registry,
  httpRequestsTotal,
  httpRequestDuration,
  cacheHitsTotal,
  cacheMissesTotal,
  cacheStaleServedTotal,
  rateLimitRejectedTotal,
  rateLimitFallbackTotal,
  circuitBreakerState,
  circuitBreakerFailures,
  queueDepth,
  queueFailedTotal,
  outboxPending,
  outboxPublishTotal,
  ordersTotal,
  stockRemaining,
  mongodbOperationsTotal,
  mongodbOperationDuration,
  mongodbServerConnections,
  mongodbShardDocuments,
  replicaSetMemberState,
  replicaHealthGauge,
  stockReconcileDrift,
  stockReconcileRuns,
  sseConnections,
  idempotencyOutcomes,
  stockGateOperations,
  traceEventsTotal,
};

export const renderMetrics = async (): Promise<string> => registry.metrics();

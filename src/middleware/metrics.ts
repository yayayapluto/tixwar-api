import type { NextFunction, Request, Response } from 'express';
import { metrics } from '../infra/metrics/registry.ts';

const routeLabel = (req: Request): string => {
  const route = req.route as { path?: string } | undefined;
  if (route?.path) return `${req.baseUrl}${route.path}`;
  return req.baseUrl || req.path;
};

export const createMetricsMiddleware = () => {
  return (req: Request, res: Response, next: NextFunction) => {
    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
      const labels = {
        route: routeLabel(req),
        method: req.method,
        status: String(res.statusCode),
      };
      metrics.httpRequestsTotal.inc(labels);
      metrics.httpRequestDuration.observe(labels, seconds);
    });
    next();
  };
};

import { createServer, type Server } from 'node:http';
import { createLogger } from '../../shared/logger.ts';
import { renderMetrics } from './registry.ts';

const logger = createLogger('metrics-server');

export const startMetricsServer = (port: number): Server => {
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && (req.url === '/metrics' || req.url === '/')) {
      try {
        const body = await renderMetrics();
        res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
        res.end(body);
        return;
      } catch (error) {
        logger.warn({ err: error }, 'metrics render failed');
        res.writeHead(500);
        res.end();
        return;
      }
    }
    res.writeHead(404);
    res.end();
  });

  server.listen(port, () => {
    logger.info({ port }, 'metrics server listening');
  });
  return server;
};

import { createMockGateway } from './app.ts';

const port = Number(process.env.MOCK_GATEWAY_PORT ?? 4000);
const gateway = createMockGateway();

const started = await gateway.listen(port);
console.log(JSON.stringify({ service: 'mock-gateway', port: started.port, status: 'listening' }));

const shutdown = (): void => {
  started.server.close(() => process.exit(0));
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

import { check } from 'k6';
import http from 'k6/http';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    http_req_failed: ['rate<0.01'],
  },
};

export default function smoke() {
  const health = http.get(`${BASE_URL}/health`);
  check(health, {
    'health is 200': (res) => res.status === 200,
    'health reports ok': (res) => res.json('status') === 'ok',
  });

  const ready = http.get(`${BASE_URL}/ready`);
  check(ready, { 'ready is 200 or 503': (res) => [200, 503].includes(res.status) });

  const events = http.get(`${BASE_URL}/v1/events?limit=5`);
  check(events, {
    'events is 200': (res) => res.status === 200,
    'events has data array': (res) => Array.isArray(res.json('data')),
  });

  const openapi = http.get(`${BASE_URL}/openapi.json`);
  check(openapi, { 'openapi is 200': (res) => res.status === 200 });
}

import { check, sleep } from 'k6';
import http from 'k6/http';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';

export const options = {
  scenarios: {
    soak: {
      executor: 'constant-vus',
      vus: Number(__ENV.VUS || 30),
      duration: __ENV.DURATION || '2m',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.02'],
    http_req_duration: ['p(95)<500'],
  },
};

export default function soakScenario() {
  const events = http.get(`${BASE_URL}/v1/events?limit=20`);
  check(events, { 'events 200': (res) => res.status === 200 });

  const ready = http.get(`${BASE_URL}/ready`);
  check(ready, { 'ready not 500': (res) => res.status !== 500 });

  const metrics = http.get(`${BASE_URL}/metrics`);
  check(metrics, { 'metrics 200': (res) => res.status === 200 });

  sleep(0.5);
}

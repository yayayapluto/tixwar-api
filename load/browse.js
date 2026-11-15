import { check, sleep } from 'k6';
import http from 'k6/http';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';

export const options = {
  scenarios: {
    browse: {
      executor: 'constant-vus',
      vus: Number(__ENV.VUS || 50),
      duration: __ENV.DURATION || '30s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<300'],
  },
};

export default function browseScenario() {
  const responses = http.batch([
    ['GET', `${BASE_URL}/v1/events?limit=20`, null, { tags: { name: 'GET /v1/events' } }],
    [
      'GET',
      `${BASE_URL}/v1/events?limit=20&city=jakarta&sort=-startsAt`,
      null,
      { tags: { name: 'GET /v1/events filtered' } },
    ],
    ['GET', `${BASE_URL}/health`, null, { tags: { name: 'GET /health' } }],
  ]);

  check(responses[0], { 'events 200': (res) => res.status === 200 });
  check(responses[1], { 'filtered events 200': (res) => res.status === 200 });
  sleep(0.1);
}

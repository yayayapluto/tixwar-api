import { check, sleep } from 'k6';
import http from 'k6/http';
import { Rate } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const rateLimited = new Rate('rate_limited_rate');

export const options = {
  scenarios: {
    abuse: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.RATE || 200),
      timeUnit: '1s',
      duration: __ENV.DURATION || '20s',
      preAllocatedVUs: 50,
      maxVUs: 200,
    },
  },
  thresholds: {
    rate_limited_rate: ['rate>0.5'],
  },
};

export default function abuseScenario() {
  const response = http.get(`${BASE_URL}/v1/events?limit=10`, {
    headers: { 'X-Forwarded-For': '203.0.113.10' },
    tags: { name: 'GET /v1/events (abuse)' },
  });
  rateLimited.add(response.status === 429);
  check(response, {
    'status is 200 or 429': (res) => [200, 429].includes(res.status),
    'retry-after present on 429': (res) =>
      res.status !== 429 || res.headers['Retry-After'] !== undefined,
  });
  sleep(0.01);
}

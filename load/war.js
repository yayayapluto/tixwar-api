import { check, sleep } from 'k6';
import http from 'k6/http';
import { Rate } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const TIER_ID = __ENV.TIER_ID || '';
const TOKENS_FILE = __ENV.TOKENS_FILE || '';
const TOKENS = TOKENS_FILE
  ? open(TOKENS_FILE)
      .split(/\r?\n|,/)
      .map((token) => token.trim())
      .filter((token) => token.length > 0)
  : (__ENV.TOKENS || '').split(',').filter((token) => token.length > 0);

const soldOut = new Rate('sold_out_rate');
const created = new Rate('order_created_rate');

http.setResponseCallback(http.expectedStatuses(201, 409, 429));

export const options = {
  scenarios: {
    war: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: __ENV.RAMP_UP || '20s', target: Number(__ENV.VUS || 1000) },
        { duration: __ENV.HOLD || '40s', target: Number(__ENV.VUS || 1000) },
        { duration: '10s', target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<2000'],
    order_created_rate: ['rate>=0'],
    sold_out_rate: ['rate>=0'],
  },
};

export default function warScenario() {
  if (!TIER_ID || TOKENS.length === 0) {
    throw new Error(
      'TIER_ID and TOKENS (or TOKENS_FILE) env vars are required for the war scenario',
    );
  }
  const token = TOKENS[__VU % TOKENS.length];
  const payload = JSON.stringify({ tierId: TIER_ID, quantity: 1 });
  const response = http.post(`${BASE_URL}/v1/orders`, payload, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'Idempotency-Key': `war-${__VU}-${__ITER}-${Date.now()}`,
    },
    tags: { name: 'POST /v1/orders' },
  });

  created.add(response.status === 201);
  soldOut.add(response.status === 409);
  check(response, {
    'status is 201, 409 or 429': (res) => [201, 409, 429].includes(res.status),
  });
  sleep(0.2);
}

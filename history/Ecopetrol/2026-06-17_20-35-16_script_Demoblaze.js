import http from 'k6/http';
import { sleep, check } from 'k6';

export const options = {
  vus: Number(__ENV.VUS) || 10,
  duration: (__ENV.DURATION || '30') + 's',
  thresholds: {
    http_req_duration: ['p(95)<500'],
  },
};

export default function () {
  const res = http.get('https://www.demoblaze.com/');

  check(res, {
    'status is 200': (r) => r.status === 200,
  });

  sleep(1);
}
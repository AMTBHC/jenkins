import http from 'k6/http';
import { check, sleep, group } from 'k6';

export const options = {
  vus: Number(__ENV.VUS) || 5,
  duration: (__ENV.DURATION || '300') + 's',
  thresholds: {
    http_req_duration: ['p(95)<500'], // P95 must be below 500ms
    http_req_failed: ['rate<0.01'],   // Error rate must be below 1%
  },
};

const BASE_URL = 'https://app-central-ecopetrol-geeqdnayfth9d7cx.centralus-01.azurewebsites.net';

export default function () {
  group('HU 1: Rendimiento y Concurrencia en el Proceso de Autenticación (Login)', () => {
    const url = `${BASE_URL}/talento/login`;
    const payload = JSON.stringify({
      username: 'cmedina', // TODO: reemplazar credenciales
      password: 'Abc123',  // TODO: reemplazar credenciales
    });
    const params = {
      headers: {
        'Content-Type': 'application/json',
      },
    };

    const res = http.post(url, payload, params);

    check(res, {
      'status is 200': (r) => r.status === 200,
      'response body contains token': (r) => {
        try {
          const jsonBody = r.json();
          return jsonBody && typeof jsonBody.token === 'string' && jsonBody.token.length > 0;
        } catch (e) {
          return false; // Handle cases where response is not valid JSON
        }
      },
    });

    sleep(1); // Simulate think time
  });
}
import http from 'k6/http';
import { check, sleep, group } from 'k6';

const BASE_URL = 'https://app-central-ecopetrol-geeqdnayfth9d7cx.centralus-01.azurewebsites.net';

export const options = {
  vus: Number(__ENV.VUS) || 5,
  duration: (__ENV.DURATION || '30') + 's',
  thresholds: {
    http_req_duration: ['p(95)<500'], // P95 debe ser menor a 500ms
    http_req_failed: ['rate<0.01'],   // Tasa de error debe ser menor al 1%
  },
};

export default function () {
  group('HU 1: Proceso de Autenticación (Login)', () => {
    const url = `${BASE_URL}/talento/login`;
    const payload = JSON.stringify({
      usuario: 'cmedina', // TODO: reemplazar credenciales o usar un generador de datos
      contrasena: 'ABC123', // TODO: reemplazar credenciales o usar un generador de datos
    });
    const params = {
      headers: {
        'Content-Type': 'application/json',
      },
    };

    const res = http.post(url, payload, params);

    check(res, {
      'status is 200': (r) => r.status === 200,
      'response body contains token or success message': (r) => r.body.includes('token') || r.body.includes('success'),
    });

    sleep(1); // Simula un tiempo de pensamiento de 1 segundo
  });
}
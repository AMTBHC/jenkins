import http from 'k6/http';
import { check, sleep, group } from 'k6';

export const options = {
  vus: Number(__ENV.VUS) || 10,
  duration: (__ENV.DURATION || '500') + 's',
  thresholds: {
    http_req_duration: ['p(95)<500'],
    http_req_failed: ['rate<0.01'],
  },
};

const BASE_URL = 'https://app-central-ecopetrol-geeqdnayfth9d7cx.centralus-01.azurewebsites.net';

export default function () {
  group('HU 2: Consulta de Listados de Talento Humano', function () {
    let res;

    // GET /talento/listarVacaciones
    res = http.get(`${BASE_URL}/talento/listarVacaciones`);
    check(res, {
      'listarVacaciones status is 200': (r) => r.status === 200,
    });
    sleep(1);

    // GET /talento/listarIncapacidades
    res = http.get(`${BASE_URL}/talento/listarIncapacidades`);
    check(res, {
      'listarIncapacidades status is 200': (r) => r.status === 200,
    });
    sleep(1);

    // GET /talento/listarCalamidades
    res = http.get(`${BASE_URL}/talento/listarCalamidades`);
    check(res, {
      'listarCalamidades status is 200': (r) => r.status === 200,
    });
    sleep(1);

    // GET /talento/listarDiasCumpleanios
    res = http.get(`${BASE_URL}/talento/listarDiasCumpleanios`);
    check(res, {
      'listarDiasCumpleanios status is 200': (r) => r.status === 200,
    });
    sleep(1);
  });
}
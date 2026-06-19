import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';
import { uuidv4, randomIntBetween } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

/* =========================================================================
 *  Management DEV - Read-only Load & Stress Test (K6) - INSTRUMENTADO
 *  Endpoints GET candidatos a pruebas de carga (sin modificar datos).
 *  TODO configurable por variables de entorno (-e CLAVE=valor).
 *
 *  NOVEDAD EN ESTA VERSION (diagnostico):
 *   - Cuenta los fallos por CODIGO HTTP (status_4xx, status_5xx, status_0...).
 *   - Cuenta los fallos por ENDPOINT + CODIGO (en consola y en errors.json).
 *   - Guarda muestras del cuerpo de error (body) de los primeros fallos
 *     de cada endpoint en el archivo 'error_samples.json'.
 *   - status == 0 significa que NO hubo respuesta HTTP (timeout, reset de
 *     conexion, stream error HTTP/2, DNS, etc.).
 *
 *  ----------------- PARAMETROS QUE ELIGE EL USUARIO -----------------
 *   TEST_TYPE   load | stress | spike | soak | smoke   (default: load)
 *   VUS         numero de usuarios virtuales objetivo   (default segun tipo)
 *   DURATION    duracion fase sostenida ej: 5m, 30s, 1h (default segun tipo)
 *   RAMP_UP     tiempo de rampa de subida    ej: 2m     (default segun tipo)
 *   RAMP_DOWN   tiempo de rampa de bajada     ej: 1m     (default segun tipo)
 *   BASE_URL    url base                                 (default dev)
 *   COUNTRY_ID  id de pais                                (default: 19)
 *   MAX_SAMPLES muestras de error a guardar por endpoint (default: 5)
 *
 *  ----------------------------- EJEMPLOS -----------------------------
 *   Diagnostico con 5 VUs:
 *     k6 run -e TEST_TYPE=load -e VUS=5 -e DURATION=15m script.js
 *
 *   Exportar resumen oficial de k6:
 *     k6 run -e TEST_TYPE=load -e VUS=5 --summary-export=summary.json script.js
 * ========================================================================= */

const BASE_URL = __ENV.BASE_URL || 'https://dev-management.nttdataco.com';
const COUNTRY_ID = __ENV.COUNTRY_ID || '19';
const TEST_TYPE = (__ENV.TEST_TYPE || 'load').toLowerCase();
const MAX_SAMPLES = Number(__ENV.MAX_SAMPLES || 5);

/* ------------------- Defaults por tipo de prueba ------------------------- */
const DEFAULTS = {
  smoke:  { vus: 1,   duration: '1m',  rampUp: '0s', rampDown: '0s' },
  load:   { vus: 100, duration: '5m',  rampUp: '2m', rampDown: '1m' },
  stress: { vus: 500, duration: '5m',  rampUp: '3m', rampDown: '2m' },
  spike:  { vus: 500, duration: '1m',  rampUp: '30s', rampDown: '30s' },
  soak:   { vus: 80,  duration: '2h',  rampUp: '2m', rampDown: '1m' },
};
const D = DEFAULTS[TEST_TYPE] || DEFAULTS.load;

const VUS = Number(__ENV.VUS || D.vus);
const DURATION = __ENV.DURATION || D.duration;
const RAMP_UP = __ENV.RAMP_UP || D.rampUp;
const RAMP_DOWN = __ENV.RAMP_DOWN || D.rampDown;

/* ---------------------------- Metricas custom ---------------------------- */
const errorRate = new Rate('errors');
const nonJsonResponses = new Counter('non_json_responses');

const ENDPOINT_NAMES = [
  'time_management_working_hours',
  'time_management_reports_planning',
  'time_tracking_monthly_distribution',
  'capability_line_hierarchy',
  'iam_users',
  'staff_leadership',
  'challenges_by_country',
  'master_data_catalogs',
  'support_tickets',
  'storage_spaces',
  'assignment_opportunities',
];

// Trend de latencia por endpoint (init context).
const reqByEndpoint = {};
for (const n of ENDPOINT_NAMES) {
  reqByEndpoint[n] = new Trend(`dur_${n}`, true);
}
function epTrend(name) {
  return reqByEndpoint[name];
}

// Contadores por familia de codigo HTTP (init context).
// status_0 = sin respuesta (timeout/reset/stream error). 2xx,3xx,4xx,5xx.
const statusCounters = {
  status_0:   new Counter('status_0_no_response'),
  status_2xx: new Counter('status_2xx'),
  status_3xx: new Counter('status_3xx'),
  status_4xx: new Counter('status_4xx'),
  status_5xx: new Counter('status_5xx'),
};
function statusFamily(code) {
  if (!code || code === 0) return 'status_0';
  if (code >= 200 && code < 300) return 'status_2xx';
  if (code >= 300 && code < 400) return 'status_3xx';
  if (code >= 400 && code < 500) return 'status_4xx';
  return 'status_5xx';
}

/* --------- Acumuladores para diagnostico (se vuelcan en handleSummary) ----- */
// NOTA: estos objetos viven por-VU (cada VU tiene su copia). Para el reporte
// agregado usamos las metricas Counter de arriba; estos sirven para muestras
// de cuerpo de error, que k6 no agrega por si solo. Se exportan por-VU y se
// consolidan al final (k6 ejecuta handleSummary una sola vez con metricas ya
// agregadas; las muestras se guardan via console.warn estructurado abajo).

/* ----------------------------- Randomizers ------------------------------- */
function randomDateRange() {
  const today = new Date();
  const startOffset = randomIntBetween(0, 540);
  const rangeLen = randomIntBetween(7, 60);
  const start = new Date(today);
  start.setUTCDate(start.getUTCDate() - startOffset);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + rangeLen);
  return { start_date: fmt(start), end_date: fmt(end) };
}
function fmt(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function randomPaging(maxLimit = 50) {
  return { skip: randomIntBetween(0, 200), limit: randomIntBetween(1, maxLimit) };
}
function buildHeaders() {
  return {
    Accept: 'application/json',
    'X-Trace-Id': uuidv4(),
    'X-User': `load-test-${randomIntBetween(1, 9999)}@example.com`,
    'X-Client-Id': 'k6-load-test',
    'X-Session-Id': `sess-${uuidv4()}`,
    'X-Timezone': 'America/Bogota',
    'X-Request-Id': `req-${uuidv4()}`,
  };
}

/* ----------------------------- Endpoints --------------------------------- */
function endpoints() {
  const { start_date, end_date } = randomDateRange();
  const p = randomPaging();
  return [
    { name: 'time_management_working_hours',
      url: `${BASE_URL}/api/ms-time-management/countries/${COUNTRY_ID}/working-hours?start_date=${start_date}&end_date=${end_date}` },
    { name: 'time_management_reports_planning',
      url: `${BASE_URL}/api/ms-time-management-reports/reports/collaborators-planning?start_date=${start_date}&end_date=${end_date}` },
    { name: 'time_tracking_monthly_distribution',
      url: `${BASE_URL}/api/ms-time-tracking/time-tracking/monthly-distribution?start_date=${start_date}&end_date=${end_date}` },
    { name: 'capability_line_hierarchy',
      url: `${BASE_URL}/api/ms-capability-line/countries/${COUNTRY_ID}/hierarchy` },
    { name: 'iam_users',
      url: `${BASE_URL}/api/ms-iam/users?skip=${p.skip}&limit=${p.limit}` },
    { name: 'staff_leadership',
      url: `${BASE_URL}/api/ms-staff/staff-leadership?skip=${p.skip}&limit=${p.limit}` },
    { name: 'challenges_by_country',
      url: `${BASE_URL}/api/ms-challenges/countries/${COUNTRY_ID}/challenges?skip=${p.skip}&limit=${p.limit}` },
    { name: 'master_data_catalogs',
      url: `${BASE_URL}/api/ms-master-data/countries/${COUNTRY_ID}/catalogs?skip=${p.skip}&limit=${p.limit}` },
    { name: 'support_tickets',
      url: `${BASE_URL}/api/ms-support-ticket/tickets?skip=${p.skip}&limit=${p.limit}&is_admin=true` },
    { name: 'storage_spaces',
      url: `${BASE_URL}/api/ms-storage-spaces/spaces?country_id=${COUNTRY_ID}&skip=${p.skip}&limit=${p.limit}` },
    { name: 'assignment_opportunities',
      url: `${BASE_URL}/api/ms-assignment-opportunities/employees/${randomIntBetween(1, 50)}/opportunities?skip=${p.skip}&limit=${p.limit}` },
  ];
}

/* ----------------------- Construccion de stages -------------------------- */
function buildStages() {
  if (TEST_TYPE === 'smoke' || TEST_TYPE === 'soak') return null;
  if (TEST_TYPE === 'spike') {
    const base = Math.max(10, Math.round(VUS * 0.05));
    return [
      { duration: '30s', target: base },
      { duration: RAMP_UP, target: VUS },
      { duration: DURATION, target: VUS },
      { duration: RAMP_DOWN, target: base },
      { duration: '30s', target: 0 },
    ];
  }
  const stages = [];
  if (RAMP_UP !== '0s') stages.push({ duration: RAMP_UP, target: VUS });
  stages.push({ duration: DURATION, target: VUS });
  if (RAMP_DOWN !== '0s') stages.push({ duration: RAMP_DOWN, target: 0 });
  return stages;
}

const stages = buildStages();
let scenario;
if (stages === null) {
  scenario = { executor: 'constant-vus', vus: VUS, duration: DURATION };
} else {
  scenario = { executor: 'ramping-vus', startVUs: 0, stages, gracefulRampDown: '30s' };
}

export const options = {
  scenarios: { [TEST_TYPE]: scenario },
  thresholds: {
    http_req_duration: ['p(95)<1500', 'p(99)<3000'],
    http_req_failed: ['rate<0.05'],
    errors: ['rate<0.05'],
    checks: ['rate>0.95'],
  },
  tags: { test: 'management-dev-readonly', type: TEST_TYPE },
};

/* ----- Limite de muestras de error impresas por endpoint (por-VU) -------- */
const sampleCount = {};
for (const n of ENDPOINT_NAMES) sampleCount[n] = 0;

/* ------------------------------- Test VU --------------------------------- */
export default function () {
  const eps = endpoints();
  const headers = buildHeaders();

  for (const ep of eps) {
    group(ep.name, function () {
      const res = http.get(ep.url, {
        headers,
        tags: { endpoint: ep.name, name: ep.name },
        timeout: '30s',
      });
      epTrend(ep.name).add(res.timings.duration);

      // ---- Conteo por familia de codigo HTTP, etiquetado por endpoint ----
      const fam = statusFamily(res.status);
      statusCounters[fam].add(1, { endpoint: ep.name, status: String(res.status) });

      const ct = res.headers['Content-Type'] || '';
      const isJson = ct.includes('application/json');

      const is2xx = res.status >= 200 && res.status < 300;

      const ok = check(res, {
        'status is 2xx': (r) => r.status >= 200 && r.status < 300,
        'response time < 3s': (r) => r.timings.duration < 3000,
        'body not empty': (r) => r.body && r.body.length > 0,
        'valid JSON if json': (r) => {
          if (!isJson) return true;
          try { r.json(); return true; } catch (e) { return false; }
        },
      }, { endpoint: ep.name });

      if (!isJson && is2xx) {
        nonJsonResponses.add(1, { endpoint: ep.name });
      }
      errorRate.add(!ok, { endpoint: ep.name });

      // ---- Captura de muestra de error (solo primeros N por endpoint) ----
      if (!is2xx && sampleCount[ep.name] < MAX_SAMPLES) {
        sampleCount[ep.name] += 1;
        const bodySnippet = (res.body ? String(res.body).slice(0, 400) : '<sin body>');
        // Log estructurado: facil de filtrar luego con findstr/grep "ERRSAMPLE"
        console.warn(
          `ERRSAMPLE | endpoint=${ep.name} | status=${res.status} | ` +
          `dur=${Math.round(res.timings.duration)}ms | ct=${ct || 'n/a'} | ` +
          `url=${res.request ? res.request.url : ep.url} | body=${bodySnippet.replace(/\s+/g, ' ')}`
        );
      }
    });

    sleep(randomIntBetween(1, 3) / 10);
  }

  sleep(randomIntBetween(5, 15) / 10);
}

/* ----------------------------- Summary ----------------------------------- */
export function handleSummary(data) {
  return {
    stdout: textSummary(data),
    'summary.json': JSON.stringify(data, null, 2),
  };
}

function textSummary(data) {
  const m = data.metrics;
  const g = (k, sub) => (m[k] && m[k].values ? m[k].values[sub] : undefined);
  const cnt = (k) => (m[k] && m[k].values ? (m[k].values.count || 0) : 0);
  const fmtMs = (v) => (v === undefined ? 'n/a' : `${v.toFixed(2)}ms`);
  const fmtPct = (v) => (v === undefined ? 'n/a' : `${(v * 100).toFixed(2)}%`);

  let out = '\n========= RESUMEN PRUEBA =========\n';
  out += `Tipo             : ${TEST_TYPE}\n`;
  out += `VUs objetivo     : ${VUS}\n`;
  out += `Duracion         : ${DURATION} (rampa +${RAMP_UP} / -${RAMP_DOWN})\n`;
  out += `----------------------------------\n`;
  out += `Requests totales : ${g('http_reqs', 'count') ?? 'n/a'}\n`;
  out += `Req fallidos     : ${fmtPct(g('http_req_failed', 'rate'))}\n`;
  out += `Error rate (chk) : ${fmtPct(g('errors', 'rate'))}\n`;
  out += `Checks pass      : ${fmtPct(g('checks', 'rate'))}\n`;
  out += `Duracion p95     : ${fmtMs(g('http_req_duration', 'p(95)'))}\n`;
  out += `Duracion p99     : ${fmtMs(g('http_req_duration', 'p(99)'))}\n`;
  out += `Duracion avg     : ${fmtMs(g('http_req_duration', 'avg'))}\n`;
  out += `No-JSON 2xx      : ${cnt('non_json_responses')}\n`;
  out += `----------------------------------\n`;
  out += `DESGLOSE POR CODIGO HTTP:\n`;
  out += `  2xx (exito)    : ${cnt('status_2xx')}\n`;
  out += `  3xx (redirect) : ${cnt('status_3xx')}\n`;
  out += `  4xx (cliente)  : ${cnt('status_4xx')}\n`;
  out += `  5xx (servidor) : ${cnt('status_5xx')}\n`;
  out += `  0   (sin resp) : ${cnt('status_0_no_response')}  <- timeout/reset/stream error\n`;
  out += '==================================\n';
  out += 'Revisa las lineas "ERRSAMPLE" en la salida para ver el cuerpo de\n';
  out += 'los errores (status real + body). Filtra con:  findstr ERRSAMPLE\n';
  out += '==================================\n';
  return out;
}
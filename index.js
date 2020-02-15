const parser = require('ua-parser-js');

// settings
const MAX_REQUESTS_PER_BATCH = process.env.MAX_REQUESTS_PER_BATCH || 150;
const MAX_TIME_AWAIT_PER_BATCH = process.env.MAX_TIME_AWAIT_PER_BATCH || 10 * 1000;

const INFLUXDB_HOST = process.env.INFLUXDB_HOST;
const INFLUXDB_DATABASE = process.env.INFLUXDB_DATABASE;
const INFLUXDB_METRIC = process.env.INFLUXDB_METRIC;
const INFLUXDB_USERNAME = process.env.INFLUXDB_USERNAME;
const INFLUXDB_PASSWORD = process.env.INFLUXDB_PASSWORD;
const INFLUXDB_URL = `${INFLUXDB_HOST}/write?db=${INFLUXDB_DATABASE}&precision=s&u=${INFLUXDB_USERNAME}&p=${INFLUXDB_PASSWORD}`;

// global vars
let requests = [];
let batchIsRunning = false;

addEventListener('fetch', event => {
  event.passThroughOnException();
  event.respondWith(logRequests(event));
})

async function logRequests(event) {
  let requestStartTime, requestEndTime;
  if (!batchIsRunning) {
    event.waitUntil(handleBatch(event));
  }
  if (requests.length >= MAX_REQUESTS_PER_BATCH) {
    event.waitUntil(sendMetricsToInfuxDB())
  }
  requestStartTime = Date.now();
  const response = await fetch(event.request);
  requestEndTime = Date.now();

  requests.push(getRequestData(event.request, response, requestStartTime, requestEndTime));

  return response;
}

async function handleBatch(event) {
  batchIsRunning = true;
  await sleep(MAX_TIME_AWAIT_PER_BATCH);
  try {
    if (requests.length) event.waitUntil(sendMetricsToInfuxDB())
  } catch (e) {
    console.error(e);
  }
  requests = [];
  batchIsRunning = false;
}

function sleep(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}

function getRequestData(request, response, startTime, endTime) {
  const cfData = request.cf || {};
  const timestamp = Math.floor(Date.now() / 1000);
  const originResponse = response || {};
  return {
    'timestamp': timestamp,
    'userAgent': request.headers.get('user-agent'),
    'referer': request.headers.get('Referer'),
    'ip': request.headers.get('CF-Connecting-IP'),
    'countryCode': cfData.country,
    'url': request.url,
    'method': request.method,
    'status': originResponse.status,
    'originTime': (endTime - startTime),
    'cfCache': (originResponse) ? (response.headers.get('CF-Cache-Status') || 'miss') : 'miss',
  };

}

function formMetricLine(data) {
  let referer;
  const url = new URL(data.url);
  const utmSource = url.searchParams.get('utm_source') || 'empty';
  const ua = parser(data.userAgent);
  try {
    referer = new URL(data.referer);
  } catch {
    referer = {
      hostname: 'empty'
    };
  }
  return `${INFLUXDB_METRIC},status_code=${data.status},url=${data.url},hostname=${url.hostname},pathname=${url.pathname},method=${data.method},cf_cache=${data.cfCache},country=${data.countryCode},referer=${referer.hostname},utm_source=${utmSource},browser=${ua.browser.name},os=${ua.os.name},device=${ua.device.type} duration=${data.originTime} ${data.timestamp}`
}

async function sendMetricsToInfuxDB() {
  const metrics = requests.map(formMetricLine).join('\n');
  console.log("posting", metrics);
  try {
    return fetch(INFLUXDB_URL, {
      method: 'POST',
      body: metrics,
    }).then(function (r) {
      return r;
    });
  } catch (err) {
    console.log(err.stack || err);
  }
}

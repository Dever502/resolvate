// Stub of the console backend for browser tests: serves the production build the way
// src/resolvate/console.py does (same headers — kept equal by tests/test_console_next.py)
// and fakes the API calls each scenario needs. Control endpoints live under /__stub/.
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.STUB_PORT ?? 4173);
const BUILD = fileURLToPath(new URL("../../../src/resolvate/console_next/", import.meta.url));
const HEADERS = JSON.parse(readFileSync(new URL("../headers.json", import.meta.url), "utf8"));
const ASSET = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(js|css)$/;
const TYPES = { js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8" };
const COOKIE = "resolvate_session=stub-session";
export const ACCOUNT = { id: "a1", login: "operator", name: "Оператор Тест", role: "operator", active: true, telegram_id: null };
export const PASSWORD = "correct horse battery";

let scenario = {};
let meCalls = 0;
let log = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hasSession = (request) => (request.headers.cookie ?? "").split(/;\s*/).includes(COOKIE);

function send(response, status, headers, body = "") {
  response.writeHead(status, headers);
  response.end(body);
}
function json(response, status, body, extra = {}) {
  send(response, status, { ...HEADERS.api, "content-type": "application/json", ...extra }, JSON.stringify(body));
}
async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return {};
  }
}

// /console/me answers: "session" (200 with the cookie, else 401), an HTTP status, an object
// {status, detail, delay}, or "network" (connection dropped). A list is consumed call by call.
async function me(request, response) {
  const answers = scenario.me ?? "session";
  let answer = Array.isArray(answers) ? answers[Math.min(meCalls, answers.length - 1)] : answers;
  meCalls++;
  if (typeof answer !== "object") answer = { status: answer };
  await sleep(answer.delay ?? scenario.meDelay ?? 0);
  if (answer.status === "network") return request.socket.destroy();
  if (answer.status === "session" || answer.status === undefined) {
    return hasSession(request)
      ? json(response, 200, { account: ACCOUNT, csrf: "stub-csrf" })
      : json(response, 401, { detail: "Войдите в панель." });
  }
  if (answer.status === 502) return send(response, 502, { "content-type": "text/html" }, "<html>502 Bad Gateway</html>");
  return json(response, answer.status, { detail: answer.detail ?? "Ошибка сервера." });
}

http.createServer(async (request, response) => {
  const url = new URL(request.url, "http://stub");
  const path = url.pathname;
  if (!path.startsWith("/__stub/")) log.push({ method: request.method, path, at: Date.now() });

  if (path === "/__stub/health") return send(response, 200, {}, "ok");
  if (path === "/__stub/scenario" && request.method === "POST") {
    scenario = await readJson(request);
    meCalls = 0;
    log = [];
    return json(response, 200, { ok: true });
  }
  if (path === "/__stub/log") return json(response, 200, log);

  if (path === "/console/next") return send(response, 307, { ...HEADERS.api, location: `next/${url.search}` });
  if (path === "/console/next/") {
    if (!existsSync(`${BUILD}index.html`)) return json(response, 404, { detail: "Not Found" });
    return send(response, 200, { ...HEADERS.document, "content-type": "text/html; charset=utf-8" }, readFileSync(`${BUILD}index.html`));
  }
  const asset = path.match(/^\/console\/next\/assets\/([^/]+)$/);
  if (asset) {
    const name = asset[1];
    const kind = name.match(ASSET)?.[1];
    if (!kind || !existsSync(`${BUILD}assets/${name}`)) return json(response, 404, { detail: "Not Found" });
    if (name.startsWith("app-")) await sleep(scenario.appDelay ?? 0);
    const accepted = (request.headers["accept-encoding"] ?? "").split(",").map((part) => part.trim().split(";")[0]);
    for (const [coding, suffix] of [["br", ".br"], ["gzip", ".gz"]]) {
      if (accepted.includes(coding) && existsSync(`${BUILD}assets/${name}${suffix}`)) {
        return send(response, 200, { ...HEADERS.asset, "content-type": TYPES[kind], "content-encoding": coding },
          readFileSync(`${BUILD}assets/${name}${suffix}`));
      }
    }
    return send(response, 200, { ...HEADERS.asset, "content-type": TYPES[kind] }, readFileSync(`${BUILD}assets/${name}`));
  }

  if (path === "/console/me" && request.method === "GET") return me(request, response);
  if (path === "/console/login" && request.method === "POST") {
    const body = await readJson(request);
    await sleep(scenario.loginDelay ?? 0);
    if (body.login !== ACCOUNT.login || body.password !== PASSWORD) {
      return json(response, 401, { detail: "Неверный логин или пароль." });
    }
    return json(response, 200, { account: ACCOUNT, csrf: "stub-csrf" },
      { "set-cookie": `${COOKIE}; Path=/console; HttpOnly; SameSite=Strict` });
  }
  if (path === "/console/logout" && request.method === "POST") {
    if (!hasSession(request)) return json(response, 401, { detail: "Войдите в панель." });
    return json(response, 200, { ok: true },
      { "set-cookie": "resolvate_session=; Path=/console; Max-Age=0; HttpOnly; SameSite=Strict" });
  }
  return json(response, 404, { detail: "Not Found" });
}).listen(PORT, "127.0.0.1");

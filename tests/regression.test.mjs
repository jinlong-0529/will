import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const queries = [];
const executions = [];
let handler;

globalThis.__testMysql = {
  createPool: () => ({
    query: async sql => {
      queries.push(sql);
      if (sql === 'SELECT 1') return [[]];
      if (sql.includes('COUNT(*)')) return [[{ count: 1 }]];
      if (sql.includes('FROM knowledge')) return [[{ id: 1, date: '2026-10-07' }]];
      if (sql.includes('FROM delivery_tasks')) return [[{ id: 2, due: '2026-10-07', status: '待处理' }]];
      if (sql.includes('FROM issues')) return [[{ id: 7, status: '跟进中', updatedAt: 1791355200 }]];
      if (sql.includes('FROM bugs')) return [[{ id: 3, date: '2026-10-07' }]];
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    execute: async (sql, values) => { executions.push({ sql, values }); return [{ affectedRows: 1, insertId: 8 }]; }
  })
};
globalThis.__testHttp = { createServer: callback => { handler = callback; return { listen: () => {}, close: () => {} }; } };
process.env.MYSQL_PASSWORD = 'test-only';

const testSource = source
  .replace("import mysql from 'mysql2/promise';", 'const mysql = globalThis.__testMysql;')
  .replace('const root = path.dirname(fileURLToPath(import.meta.url));', 'const root = process.cwd();')
  .replace('http.createServer(', 'globalThis.__testHttp.createServer(')
  .replace(/for \(const signal of \['SIGINT', 'SIGTERM'\]\).*$/m, '');
await import(`data:text/javascript,${encodeURIComponent(testSource)}`);

async function request(method, url, body) {
  const req = Readable.from(body ? [JSON.stringify(body)] : []);
  req.method = method;
  req.url = url;
  req.headers = { host: 'localhost' };
  const res = { status: 0, payload: '', writeHead(code) { this.status = code; }, end(value = '') { this.payload = value; } };
  await handler(req, res);
  return { status: res.status, body: JSON.parse(res.payload) };
}

test('日期字段由数据库直接返回纯日期，更新时间返回 Unix 时间戳', async () => {
  const response = await request('GET', '/api/data');
  assert.equal(response.status, 200);
  assert.equal(response.body.tasks[0].due, '2026-10-07');
  assert.equal(response.body.knowledge[0].date, '2026-10-07');
  assert.equal(response.body.bugs[0].date, '2026-10-07');
  assert.equal(typeof response.body.issues[0].updatedAt, 'number');
  assert.equal(queries.filter(sql => sql.includes('DATE_FORMAT(')).length, 3);
  assert.ok(queries.some(sql => sql.includes('UNIX_TIMESTAMP(updated_at) AS updatedAt')));
});

test('项目问题支持更新状态并记录真实更新时间', async () => {
  const response = await request('PATCH', '/api/issues/7', { status: '已解决' });
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  const update = executions.at(-1);
  assert.match(update.sql, /UPDATE issues SET status = \?, updated = \? WHERE id = \?/);
  assert.equal(update.values[0], '已解决');
  assert.ok(!Number.isNaN(Date.parse(update.values[1])));
  assert.equal(update.values[2], 7);
  const invalid = await request('PATCH', '/api/issues/7', { status: '未知' });
  assert.equal(invalid.status, 400);
});

test('前端脚本可解析，问题状态控件调用新接口', () => {
  const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
  new vm.Script(script);
  const dateHelper = script.match(/^    const displayDate = .*;$/m)?.[0];
  const updatedHelper = script.match(/^    const displayUpdated = .*;$/m)?.[0];
  assert.ok(dateHelper && updatedHelper);
  const displayDate = new Function(`${dateHelper}; return displayDate;`)();
  const displayUpdated = new Function(`${updatedHelper}; return displayUpdated;`)();
  assert.equal(displayDate('2026-10-07'), '2026-10-07');
  assert.match(displayUpdated(1791355200), /2026/);
  assert.notEqual(displayUpdated(1791355200), '刚刚');
  assert.match(script, /class="select issue-status"/);
  assert.match(script, /`\/api\/issues\/\$\{encodeURIComponent\(issue.id\)\}`/);
  assert.match(script, /displayUpdated\(issue.updatedAt\)/);
  assert.doesNotMatch(script, /item\.updated='刚刚'/);
});

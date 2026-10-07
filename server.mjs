/** 交付工作台服务端（MySQL 版本）。环境变量见 .env.example。 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
const database = process.env.MYSQL_DATABASE || 'delivery_workbench';
if (!process.env.MYSQL_PASSWORD) { console.error('缺少 MYSQL_PASSWORD。请参考 .env.example 配置数据库连接。'); process.exit(1); }
const pool = mysql.createPool({ host: process.env.MYSQL_HOST || '127.0.0.1', port: Number(process.env.MYSQL_PORT || 3306), user: process.env.MYSQL_USER || 'delivery_app', password: process.env.MYSQL_PASSWORD, database, waitForConnections: true, connectionLimit: Number(process.env.MYSQL_CONNECTION_LIMIT || 10), charset: 'utf8mb4', timezone: '+08:00' });

async function initDatabase() {
  await pool.query('SELECT 1');
  const [rows] = await pool.query('SELECT COUNT(*) AS count FROM knowledge');
  if (rows[0].count) return;
  const dateParts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map(part => [part.type, part.value]));
  const today = `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
  await pool.execute('INSERT INTO knowledge (title,content,tags,date) VALUES (?,?,?,?)', ['客户环境部署失败排查清单', '优先确认网络连通性、服务端口、配置文件路径和日志权限，再按日志时间线缩小范围。', '部署,排查,客户现场', today]);
  await pool.execute('INSERT INTO knowledge (title,content,tags,date) VALUES (?,?,?,?)', ['上线前交付检查要点', '核对版本号、数据备份、回滚方案、账号权限和验收材料，完成后同步客户确认。', '上线,交付,检查清单', today]);
  await pool.execute('INSERT INTO delivery_tasks (title,project,priority,due,status) VALUES (?,?,?,?,?)', ['整理项目验收材料', '华东数据平台', '高', today, '进行中']);
  await pool.execute('INSERT INTO delivery_tasks (title,project,priority,due,status) VALUES (?,?,?,?,?)', ['确认客户环境日志保留策略', '零售中台', '中', today, '待处理']);
  await pool.execute('INSERT INTO issues (title,project,source,status,updated) VALUES (?,?,?,?,?)', ['客户反馈报表导出耗时较长', '零售中台', '客户群聊', '跟进中', new Date().toISOString()]);
  await pool.execute('INSERT INTO bugs (title,project,symptom,root,prevention,date) VALUES (?,?,?,?,?,?)', ['大批量导出时接口超时', '华东数据平台', '10 万条以上数据导出时，网关在 60 秒后返回超时。', '同步查询和文件生成占用同一请求链路。', '改为异步导出任务，并增加数据量阈值提示。', today]);
}
const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
const readBody = req => new Promise((resolve, reject) => { let body = ''; req.on('data', c => { body += c; if (body.length > 100000) req.destroy(); }); req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('请求数据不是有效 JSON')); } }); });
const required = (body, keys) => keys.every(key => typeof body[key] === 'string' && body[key].trim());
const specs = { knowledge: { table: 'knowledge', columns: ['title', 'content', 'tags', 'date'] }, tasks: { table: 'delivery_tasks', columns: ['title', 'project', 'priority', 'due', 'status'] }, issues: { table: 'issues', columns: ['title', 'project', 'source', 'status', 'updated'] }, bugs: { table: 'bugs', columns: ['title', 'project', 'symptom', 'root', 'prevention', 'date'] } };

async function api(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/data') {
    const [knowledge] = await pool.query("SELECT id, title, content, tags, DATE_FORMAT(date, '%Y-%m-%d') AS date FROM knowledge ORDER BY id DESC");
    const [tasks] = await pool.query("SELECT id, title, project, priority, DATE_FORMAT(due, '%Y-%m-%d') AS due, status FROM delivery_tasks ORDER BY CASE status WHEN '已完成' THEN 1 ELSE 0 END, due ASC, id DESC");
    const [issues] = await pool.query('SELECT id, title, project, source, status, UNIX_TIMESTAMP(updated_at) AS updatedAt FROM issues ORDER BY id DESC');
    const [bugs] = await pool.query("SELECT id, title, project, symptom, root, prevention, DATE_FORMAT(date, '%Y-%m-%d') AS date FROM bugs ORDER BY id DESC");
    return json(res, 200, { knowledge, tasks, issues, bugs });
  }
  const createMatch = url.pathname.match(/^\/api\/(knowledge|tasks|issues|bugs)$/);
  if (req.method === 'POST' && createMatch) {
    const type = createMatch[1], spec = specs[type], body = await readBody(req);
    if (!required(body, spec.columns.filter(x => x !== 'tags' && x !== 'updated'))) return json(res, 400, { error: '请完整填写必填字段。' });
    const values = spec.columns.map(x => x === 'updated' ? new Date().toISOString() : String(body[x] || '').trim());
    const [result] = await pool.execute(`INSERT INTO ${spec.table} (${spec.columns.join(',')}) VALUES (${spec.columns.map(() => '?').join(',')})`, values);
    return json(res, 201, { id: result.insertId, ...Object.fromEntries(spec.columns.map((x, i) => [x, values[i]])) });
  }
  const taskMatch = url.pathname.match(/^\/api\/tasks\/(\d+)$/);
  if (req.method === 'PATCH' && taskMatch) {
    const body = await readBody(req); if (!['待处理', '进行中', '已完成'].includes(body.status)) return json(res, 400, { error: '无效任务状态。' });
    const [result] = await pool.execute('UPDATE delivery_tasks SET status = ? WHERE id = ?', [body.status, Number(taskMatch[1])]);
    return result.affectedRows ? json(res, 200, { ok: true }) : json(res, 404, { error: '任务不存在。' });
  }
  const issueMatch = url.pathname.match(/^\/api\/issues\/(\d+)$/);
  if (req.method === 'PATCH' && issueMatch) {
    const body = await readBody(req);
    if (!['待确认', '跟进中', '已解决'].includes(body.status)) return json(res, 400, { error: '无效问题状态。' });
    const [result] = await pool.execute('UPDATE issues SET status = ?, updated = ? WHERE id = ?', [body.status, new Date().toISOString(), Number(issueMatch[1])]);
    return result.affectedRows ? json(res, 200, { ok: true }) : json(res, 404, { error: '问题不存在。' });
  }
  return json(res, 404, { error: '接口不存在。' });
}
const server = http.createServer(async (req, res) => { try { const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); if (url.pathname.startsWith('/api/')) return await api(req, res, url); if (req.method !== 'GET' || !['/', '/index.html'].includes(url.pathname)) { res.writeHead(404); return res.end('Not found'); } res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff' }); fs.createReadStream(path.join(root, 'index.html')).pipe(res); } catch (error) { console.error(error); json(res, 500, { error: '服务器处理请求时发生错误。' }); } });
await initDatabase();
server.listen(port, '0.0.0.0', () => console.log(`交付工作台已启动：http://127.0.0.1:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => pool.end().then(() => process.exit(0))));

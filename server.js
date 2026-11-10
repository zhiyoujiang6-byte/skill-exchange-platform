'use strict';

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');

const ROOT = __dirname;
const DATA_FILE = path.resolve(process.env.DATA_FILE || path.join(ROOT, '.data', 'store.json'));
const PORT = Number(process.env.PORT || 3000);
const blankState = () => ({ version: 1, users: [], sessions: [], posts: [], exchanges: [], messages: [] });
let pool = null;
let localState;
let queue = Promise.resolve();

function error(status, message, code) {
  const err = new Error(message);
  err.status = status;
  err.code = code || 'REQUEST_ERROR';
  throw err;
}
function text(value, max = 2000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}
function tags(value) {
  if (typeof value === 'string') value = value.split(/[,，、\n]/);
  return [...new Set((Array.isArray(value) ? value : []).map(v => text(v, 40)).filter(Boolean))].slice(0, 12);
}
function id(prefix) { return prefix + '_' + crypto.randomBytes(9).toString('base64url'); }
function now() { return new Date().toISOString(); }
function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function publicUser(user) {
  if (!user) return null;
  return { id: user.id, name: user.name, city: user.city, teach: user.teach, want: user.want, bio: user.bio, createdAt: user.createdAt };
}
function postView(state, post) {
  return { ...post, user: publicUser(state.users.find(u => u.id === post.userId)) };
}
function exchangeView(state, exchange) {
  return {
    ...exchange,
    fromUser: publicUser(state.users.find(u => u.id === exchange.fromUserId)),
    toUser: publicUser(state.users.find(u => u.id === exchange.toUserId)),
    post: postView(state, state.posts.find(p => p.id === exchange.postId) || {}),
  };
}
function userFor(state, req, required = true) {
  const auth = req.headers.authorization || '';
  if (!auth) {
    if (required) error(401, '先创建个人名片，再开始交换', 'AUTH_REQUIRED');
    return null;
  }
  const token = auth.match(/^Bearer (.+)$/i)?.[1];
  const session = token && state.sessions.find(s => s.tokenHash === hash(token));
  const user = session && state.users.find(u => u.id === session.userId);
  if (!user) error(401, '登录状态已失效，请重新进入', 'INVALID_SESSION');
  return user;
}
function editableProfile(body, previous = {}) {
  const user = { ...previous };
  if (body.name !== undefined) user.name = text(body.name, 40);
  if (body.city !== undefined) user.city = text(body.city, 50);
  if (body.teach !== undefined) user.teach = tags(body.teach);
  if (body.want !== undefined) user.want = tags(body.want);
  if (body.bio !== undefined) user.bio = text(body.bio, 500);
  if (!user.name) error(400, '给自己起一个名字吧', 'NAME_REQUIRED');
  return { city: '', teach: [], want: [], bio: '', ...user };
}
function editablePost(body, previous = {}) {
  const post = { ...previous };
  for (const key of ['title', 'teach', 'want', 'description', 'category', 'mode', 'city', 'availability']) {
    if (body[key] !== undefined) post[key] = text(body[key], key === 'description' ? 3000 : key === 'availability' ? 400 : 100);
  }
  if (body.duration !== undefined) {
    post.duration = Number(body.duration);
    if (!Number.isFinite(post.duration) || post.duration < 15 || post.duration > 480) error(400, '每次交换时长应为 15–480 分钟');
  }
  if (body.status !== undefined) {
    if (!['active', 'paused', 'closed'].includes(body.status)) error(400, '发布状态不正确');
    post.status = body.status;
  }
  if (!post.teach || !post.want) error(400, '填上你会教的和想学的技能', 'SKILLS_REQUIRED');
  if (!post.title) post.title = '用' + post.teach + '，交换' + post.want;
  return { description: '', category: '其他', mode: 'online', city: '', duration: 60, availability: '', status: 'active', ...post };
}

async function initStore() {
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    const databaseUrl = new URL(process.env.DATABASE_URL);
    // Neon uses public certificates; keep TLS certificate and hostname checks on.
    if (databaseUrl.hostname.endsWith('.neon.tech')) databaseUrl.searchParams.set('sslmode', 'verify-full');
    pool = new Pool({ connectionString: databaseUrl.toString(), max: 5, connectionTimeoutMillis: 30000, enableChannelBinding: true });
    pool.on('error', err => console.error('Database connection error:', err.message));
    await pool.query('CREATE TABLE IF NOT EXISTS skill_exchange_state (id integer PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())');
    await pool.query('INSERT INTO skill_exchange_state(id,data) VALUES (1,$1::jsonb) ON CONFLICT(id) DO NOTHING', [JSON.stringify(blankState())]);
    console.log('Storage: PostgreSQL');
  } else {
    if (process.env.RENDER === 'true' && !process.env.DATA_FILE) throw new Error('Configure DATABASE_URL or DATA_FILE on a persistent disk before deploying.');
    await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
    try { localState = JSON.parse(await fs.readFile(DATA_FILE, 'utf8')); }
    catch (err) { if (err.code !== 'ENOENT') throw err; localState = blankState(); }
    console.log('Storage: JSON file');
  }
}
async function withStore(write, action) {
  if (pool) {
    const client = await pool.connect();
    try {
      if (write) await client.query('BEGIN');
      const result = await client.query('SELECT data FROM skill_exchange_state WHERE id=1' + (write ? ' FOR UPDATE' : ''));
      const state = result.rows[0].data;
      const value = await action(state);
      if (write) {
        await client.query('UPDATE skill_exchange_state SET data=$1::jsonb, updated_at=now() WHERE id=1', [JSON.stringify(state)]);
        await client.query('COMMIT');
      }
      return value;
    } catch (err) {
      if (write) await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally { client.release(); }
  }
  const operation = queue.then(async () => {
    const state = write ? structuredClone(localState) : localState;
    const value = await action(state);
    if (write) {
      const temporary = DATA_FILE + '.tmp';
      await fs.writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
      await fs.rename(temporary, DATA_FILE);
      localState = state;
    }
    return value;
  });
  queue = operation.then(() => {}, () => {});
  return operation;
}
async function readBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > 65536) error(413, '内容太长了，请精简后再提交');
  }
  if (!body) return {};
  try { const value = JSON.parse(body); if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(); return value; }
  catch { error(400, '提交内容格式不正确', 'INVALID_JSON'); }
}
function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
function ownExchange(state, user, exchangeId) {
  const exchange = state.exchanges.find(e => e.id === exchangeId);
  if (!exchange) error(404, '没有找到这次交换');
  if (![exchange.fromUserId, exchange.toUserId].includes(user.id)) error(403, '只能查看自己的交换');
  return exchange;
}

async function api(req, res, pathname) {
  const method = req.method;
  if (pathname === '/api/health' && method === 'GET') {
    if (pool) await pool.query('SELECT 1');
    return send(res, 200, { ok: true });
  }
  const write = ['POST', 'PATCH', 'DELETE'].includes(method);
  const body = write ? await readBody(req) : {};
  const value = await withStore(write, state => {
    if (pathname === '/api/session' && method === 'POST') {
      const user = { ...editableProfile(body), id: id('u'), createdAt: now() };
      const token = crypto.randomBytes(32).toString('base64url');
      state.users.push(user);
      state.sessions.push({ tokenHash: hash(token), userId: user.id, createdAt: now() });
      return { token, user: publicUser(user) };
    }
    const user = userFor(state, req, !['GET'].includes(method));
    if (pathname === '/api/bootstrap' && method === 'GET') {
      const exchanges = user ? state.exchanges.filter(e => e.fromUserId === user.id || e.toUserId === user.id) : [];
      const exchangeIds = new Set(exchanges.map(e => e.id));
      return {
        user: publicUser(user),
        posts: state.posts.filter(p => p.status === 'active' || p.userId === user?.id).map(p => postView(state, p)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
        exchanges: exchanges.map(e => exchangeView(state, e)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
        messages: state.messages.filter(m => exchangeIds.has(m.exchangeId)),
      };
    }
    if (pathname === '/api/profile' && method === 'PATCH') {
      Object.assign(user, editableProfile(body, user));
      return publicUser(user);
    }
    if (pathname === '/api/posts' && method === 'GET') {
      return state.posts.filter(p => p.status === 'active' || p.userId === user?.id).map(p => postView(state, p)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }
    if (pathname === '/api/posts' && method === 'POST') {
      const post = { ...editablePost(body), id: id('p'), userId: user.id, createdAt: now(), updatedAt: now() };
      state.posts.push(post);
      return postView(state, post);
    }
    const postMatch = pathname.match(/^\/api\/posts\/([\w-]+)$/);
    if (postMatch && method === 'PATCH') {
      const post = state.posts.find(p => p.id === postMatch[1]);
      if (!post) error(404, '没有找到这条发布');
      if (post.userId !== user.id) error(403, '只能修改自己的发布');
      Object.assign(post, editablePost(body, post), { updatedAt: now() });
      return postView(state, post);
    }
    if (pathname === '/api/exchanges' && method === 'GET') {
      if (!user) error(401, '请先进入个人名片');
      return state.exchanges.filter(e => [e.fromUserId, e.toUserId].includes(user.id)).map(e => exchangeView(state, e));
    }
    if (pathname === '/api/exchanges' && method === 'POST') {
      const post = state.posts.find(p => p.id === body.postId && p.status === 'active');
      if (!post) error(404, '这条发布已下架，看看其他技能吧');
      if (post.userId === user.id) error(400, '这是你自己的发布');
      if (state.exchanges.some(e => e.postId === post.id && e.fromUserId === user.id && ['pending', 'accepted'].includes(e.status))) error(409, '你已向这位伙伴发送过邀约', 'DUPLICATE_INVITE');
      const offerSkill = text(body.offerSkill, 100);
      if (!offerSkill) error(400, '填写你希望交换的技能');
      const message = text(body.message, 2000);
      let scheduledAt = text(body.scheduledAt, 60);
      if (scheduledAt && !Number.isFinite(Date.parse(scheduledAt))) error(400, '请选择有效的预约时间');
      if (scheduledAt) scheduledAt = new Date(scheduledAt).toISOString();
      const duration = Number(body.duration || post.duration || 60);
      if (!Number.isFinite(duration) || duration < 15 || duration > 480) error(400, '每次交换时长应为 15–480 分钟');
      const exchange = {
        id: id('e'), postId: post.id, fromUserId: user.id, toUserId: post.userId,
        offerSkill, requestedSkill: post.teach, message, scheduledAt, duration,
        status: 'pending', completedBy: [], createdAt: now(), updatedAt: now(),
      };
      state.exchanges.push(exchange);
      if (message) state.messages.push({ id: id('m'), exchangeId: exchange.id, userId: user.id, text: message, createdAt: now() });
      return exchangeView(state, exchange);
    }
    const exchangeMatch = pathname.match(/^\/api\/exchanges\/([\w-]+)$/);
    if (exchangeMatch && method === 'PATCH') {
      const exchange = ownExchange(state, user, exchangeMatch[1]);
      const status = body.status;
      const allowed = { pending: ['accepted', 'declined', 'cancelled'], accepted: ['completed', 'cancelled'], completed: [], declined: [], cancelled: [] };
      if (!allowed[exchange.status].includes(status)) error(409, '这次交换的状态已更新，请刷新后重试', 'INVALID_TRANSITION');
      if (['accepted', 'declined'].includes(status) && exchange.toUserId !== user.id) error(403, '请等待对方回应邀请');
      if (status === 'completed') {
        exchange.completedBy = [...new Set([...(exchange.completedBy || []), user.id])];
        if (exchange.completedBy.includes(exchange.fromUserId) && exchange.completedBy.includes(exchange.toUserId)) exchange.status = 'completed';
      } else exchange.status = status;
      exchange.updatedAt = now();
      return exchangeView(state, exchange);
    }
    const messagesMatch = pathname.match(/^\/api\/exchanges\/([\w-]+)\/messages$/);
    if (messagesMatch && ['GET', 'POST'].includes(method)) {
      if (!user) error(401, '请先进入个人名片');
      const exchange = ownExchange(state, user, messagesMatch[1]);
      if (method === 'GET') return state.messages.filter(m => m.exchangeId === exchange.id);
      const messageText = text(body.text, 3000);
      if (!messageText) error(400, '写点什么再发送吧');
      const message = { id: id('m'), exchangeId: exchange.id, userId: user.id, text: messageText, createdAt: now() };
      state.messages.push(message);
      exchange.updatedAt = now();
      return message;
    }
    error(404, '没有找到这个入口', 'NOT_FOUND');
  });
  send(res, method === 'POST' ? 201 : 200, value);
}

const mimeTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.jpg': 'image/jpeg' };
async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.url.startsWith('/api/')) {
    const origin = req.headers.origin;
    const allowed = (process.env.ALLOWED_ORIGINS || 'https://skill-exchange-platform-nrl2.onrender.com').split(',').map(s => s.trim());
    if (origin && (allowed.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  }
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname.startsWith('/api/')) return await api(req, res, pathname);
    if (!['GET', 'HEAD'].includes(req.method)) return send(res, 405, { error: '此请求方式不支持' });
    const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
    const rootAllowed = ['index.html', 'styles.css', 'app.js', 'config.js', 'motion.js', 'gsap.min.js', 'favicon.svg', 'favicon.ico', 'manifest.json'];
    const assetAllowed = /^assets\/[a-zA-Z0-9_./-]+\.(svg|png|webp|jpg|jpeg|ico)$/.test(relative) && !relative.split('/').includes('..');
    if (!rootAllowed.includes(relative) && !assetAllowed) return send(res, 404, { error: '页面不存在' });
    let file;
    try { file = await fs.readFile(path.join(ROOT, relative)); }
    catch (err) { if (err.code === 'ENOENT') return send(res, 404, { error: '页面不存在' }); throw err; }
    res.writeHead(200, { 'Content-Type': mimeTypes[path.extname(relative)] || 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : file);
  } catch (err) {
    if (err.status) return send(res, err.status, { error: err.message, code: err.code });
    console.error('Request failed:', err.message);
    send(res, 500, { error: '暂时没能完成，请稍后重试', code: 'SERVER_ERROR' });
  }
}

async function start() {
  await initStore();
  const server = http.createServer(handler);
  server.listen(PORT, '0.0.0.0', () => console.log('Skill Exchange listening on port ' + server.address().port));
  const shutdown = () => { server.close(async () => { if (pool) await pool.end(); process.exit(0); }); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return server;
}
if (require.main === module) start().catch(err => { console.error('Startup failed:', err.message); process.exit(1); });
module.exports = { start, handler, initStore };

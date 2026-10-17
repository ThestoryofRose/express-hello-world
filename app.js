// Node.js 22+; single-instance trial bot. No additional npm packages required.
const http = require('node:http');
const crypto = require('node:crypto');

function createBot(env = process.env, request = fetch) {
  const required = ['APPID', 'SECRET', 'KEY', 'VERIFICATION_TOKEN', 'OPENAI_MODEL'];
  for (const name of required) {
    if (!env[name]?.trim()) throw new Error(`Missing environment variable: ${name}`);
  }
  if (env.ENCRYPT_KEY) throw new Error('Encrypted events are not supported by this trial version. Use an SDK-based version for encrypted events.');
  const seen = new Map();
  let active = 0;
  const same = (a, b) => {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const x = Buffer.from(a), y = Buffer.from(b);
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  };
  async function post(url, data, token, timeout = 20000) {
    const response = await request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(data), signal: AbortSignal.timeout(timeout)
    });
    if (!response.ok) throw new Error(`Upstream HTTP ${response.status}`);
    const result = await response.json();
    if (result.code !== undefined && result.code !== 0) throw new Error(`Lark code ${result.code}`);
    return result;
  }
  async function reply(messageId, text) {
    const auth = await post('https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal', {
      app_id: env.APPID, app_secret: env.SECRET
    });
    if (!auth.tenant_access_token) throw new Error('Missing Lark access token');
    // Keep the text well below the Lark message size limit.
    const limited = Array.from(text).slice(0, 3500).join('');
    await post(`https://open.larksuite.com/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
      msg_type: 'text', content: JSON.stringify({ text: limited }),
      uuid: crypto.createHash('sha256').update(messageId).digest('hex').slice(0, 32)
    }, auth.tenant_access_token);
  }
  async function answer(messageId, text) {
    let output;
    try {
      if (text.length > 12000) {
        output = '消息过长，请缩短到 12000 字符以内再发送。';
      } else {
        const result = await post('https://api.openai.com/v1/responses', {
          model: env.OPENAI_MODEL,
          instructions: `你是${env.BOTNAME || 'Lark AI 助手'}。使用用户的语言清晰回答。储能问题采用工程术语，区分功率与容量，说明假设，不编造产品参数、标准条文或最新市场数据。回答控制在 1500 字以内。`,
          input: text, max_output_tokens: 1800, store: false
        }, env.KEY, 60000);
        output = (result.output || []).flatMap(item => item.content || [])
          .filter(item => item.type === 'output_text').map(item => item.text).join('\n');
        if (!output) throw new Error('No text in OpenAI response');
      }
    } catch (error) {
      // Do not log messages, request bodies, credentials or upstream response bodies.
      console.error('AI request failed:', error.name, error.message.startsWith('Upstream HTTP') ? error.message : 'request failed');
      output = '暂时无法生成回复，请稍后重试。管理员请检查 OpenAI 模型权限、API 额度和 Render 日志。';
    }
    try { await reply(messageId, output); }
    catch (error) { console.error('Lark reply failed:', error.name, /^Lark code|^Upstream HTTP/.test(error.message) ? error.message : 'request failed'); }
    finally { active--; }
  }
  const server = http.createServer(async (req, res) => {
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    };
    const path = (req.url || '').split('?')[0];
    if (req.method === 'GET' && (path === '/' || path === '/health')) return send(200, { status: 'ok', service: 'lark-ai-bot' });
    if (req.method !== 'POST' || path !== '/lark/events') return send(404, { error: 'Not found' });
    let payload;
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 65536) return send(413, { error: 'Request too large' });
        chunks.push(chunk);
      }
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid object');
    } catch { return send(400, { error: 'Invalid JSON' }); }
    if (payload.encrypt) return send(400, { error: 'Encrypted events require SDK-based implementation' });
    if (!same(payload.header?.token ?? payload.token, env.VERIFICATION_TOKEN)) return send(403, { error: 'Invalid verification token' });
    if (payload.type === 'url_verification') {
      if (typeof payload.challenge !== 'string') return send(400, { error: 'Missing challenge' });
      return send(200, { challenge: payload.challenge });
    }
    if (payload.header?.app_id !== env.APPID) return send(403, { error: 'App ID mismatch' });
    if (payload.header?.event_type !== 'im.message.receive_v1') return send(200, { code: 0 });
    const event = payload.event;
    const msg = event?.message;
    // Trial scope: human-to-bot direct text messages only. Ignore group and bot messages.
    if (event?.sender?.sender_type !== 'user' || msg?.chat_type !== 'p2p' || msg?.message_type !== 'text') return send(200, { code: 0 });
    if (typeof msg.message_id !== 'string' || !msg.message_id) return send(400, { error: 'Missing message ID' });
    let text;
    try { text = JSON.parse(msg.content).text; } catch { return send(400, { error: 'Invalid message content' }); }
    if (typeof text !== 'string' || !text.trim()) return send(200, { code: 0 });
    const now = Date.now();
    for (const [id, expires] of seen) if (expires < now) seen.delete(id);
    if (seen.has(msg.message_id)) return send(200, { code: 0 });
    if (active >= 4 || seen.size >= 10000) return send(503, { error: 'Busy, retry later' });
    seen.set(msg.message_id, now + 24 * 60 * 60 * 1000);
    active++;
    send(200, { code: 0 });
    void answer(msg.message_id, text.trim());
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}

if (require.main === module) {
  const server = createBot();
  server.listen(Number(process.env.PORT || 3001), '0.0.0.0', () => console.log('Lark bot ready: POST /lark/events'));
}
module.exports = { createBot };

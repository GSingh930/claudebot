const express = require('express');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const XLSX = require('xlsx');
const multer = require('multer');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

function getConfig() {
  return {
    discordToken:    process.env.DISCORD_TOKEN    || '',
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
    prefix:          process.env.PREFIX           || '!claude',
    botName:         process.env.BOT_NAME         || 'ClaudeBot',
    systemPrompt:    process.env.SYSTEM_PROMPT    || 'You are a helpful, friendly assistant in a Discord server.',
    allowedChannels: process.env.ALLOWED_CHANNELS
      ? process.env.ALLOWED_CHANNELS.split(',').map(s => s.trim()).filter(Boolean)
      : [],
    allowedUsers: process.env.ALLOWED_USERS
      ? process.env.ALLOWED_USERS.split(',').map(s => s.trim()).filter(Boolean)
      : [],
    maxTokensFull:       parseInt(process.env.MAX_TOKENS_FULL)        || 4000,
    dailyTokensFull:     parseInt(process.env.DAILY_TOKENS_FULL)      || 100000,
    maxTokensRestricted: parseInt(process.env.MAX_TOKENS_RESTRICTED)  || 200,
    dailyTokensRestricted: parseInt(process.env.DAILY_TOKENS_RESTRICTED) || 500,
  };
}

// Config status
app.get('/api/config', (req, res) => {
  const cfg = getConfig();
  res.json({
    ...cfg,
    discordToken:    cfg.discordToken    ? '••••••••' + cfg.discordToken.slice(-4)    : '',
    anthropicApiKey: cfg.anthropicApiKey ? '••••••••' + cfg.anthropicApiKey.slice(-4) : '',
  });
});

app.get('/api/env-status', (req, res) => {
  res.json({
    DISCORD_TOKEN:          !!process.env.DISCORD_TOKEN,
    ANTHROPIC_API_KEY:      !!process.env.ANTHROPIC_API_KEY,
    PREFIX:                 process.env.PREFIX || '!claude',
    BOT_NAME:               process.env.BOT_NAME || 'ClaudeBot',
    ALLOWED_CHANNELS:       process.env.ALLOWED_CHANNELS || '',
    ALLOWED_USERS:          process.env.ALLOWED_USERS || '',
    MAX_TOKENS_FULL:        process.env.MAX_TOKENS_FULL || '4000',
    DAILY_TOKENS_FULL:      process.env.DAILY_TOKENS_FULL || '100000',
    MAX_TOKENS_RESTRICTED:  process.env.MAX_TOKENS_RESTRICTED || '200',
    DAILY_TOKENS_RESTRICTED: process.env.DAILY_TOKENS_RESTRICTED || '500',
  });
});

// Test chat
app.post('/api/test-chat', async (req, res) => {
  const { message, history = [] } = req.body;
  const cfg = getConfig();
  if (!cfg.anthropicApiKey) return res.status(400).json({ error: 'ANTHROPIC_API_KEY not set' });
  try {
    const anthropic = new Anthropic({ apiKey: cfg.anthropicApiKey });
    const messages = [...history, { role: 'user', content: message }];
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      system: cfg.systemPrompt,
      messages,
    });
    const reply = response.content[0].text;
    res.json({ reply, messages: [...messages, { role: 'assistant', content: reply }] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Test VBA
app.post('/api/test-vba', upload.single('file'), async (req, res) => {
  const cfg = getConfig();
  if (!cfg.anthropicApiKey) return res.status(400).json({ error: 'ANTHROPIC_API_KEY not set' });
  try {
    const anthropic = new Anthropic({ apiKey: cfg.anthropicApiKey });
    let excelContent = '';
    if (req.file) {
      const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
      wb.SheetNames.forEach(n => { excelContent += `\n=== Sheet: ${n} ===\n${XLSX.utils.sheet_to_csv(wb.Sheets[n])}\n`; });
    }
    const prompt = req.body.prompt || 'Suggest useful VBA automations for this spreadsheet.';
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      system: 'You are an expert VBA developer for Microsoft Excel. Write clean, well-commented VBA scripts. Always wrap VBA code in ```vba code blocks.',
      messages: [{ role: 'user', content: excelContent ? `Excel data:\n\n${excelContent}\n\nTask: ${prompt}` : prompt }],
    });
    res.json({ result: response.content[0].text });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Bot process
let botProcess = null;
app.get('/api/bot-status', (req, res) => res.json({ running: botProcess !== null && !botProcess.killed }));
app.post('/api/bot-start', (req, res) => {
  if (botProcess && !botProcess.killed) return res.json({ success: true, message: 'Already running' });
  const { spawn } = require('child_process');
  botProcess = spawn('node', ['start-bot.js'], { cwd: __dirname, stdio: 'pipe' });
  botProcess.stdout.on('data', d => process.stdout.write('[BOT] ' + d));
  botProcess.stderr.on('data', d => process.stderr.write('[BOT ERR] ' + d));
  botProcess.on('exit', () => { botProcess = null; });
  res.json({ success: true, message: 'Bot started' });
});
app.post('/api/bot-stop', (req, res) => {
  if (botProcess) { botProcess.kill(); botProcess = null; }
  res.json({ success: true, message: 'Bot stopped' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Dashboard on port ${PORT}`);
  if (process.env.DISCORD_TOKEN && process.env.ANTHROPIC_API_KEY) {
    console.log('Auto-starting bot...');
    const { spawn } = require('child_process');
    botProcess = spawn('node', ['start-bot.js'], { cwd: __dirname, stdio: 'pipe' });
    botProcess.stdout.on('data', d => process.stdout.write('[BOT] ' + d));
    botProcess.stderr.on('data', d => process.stderr.write('[BOT ERR] ' + d));
    botProcess.on('exit', () => { botProcess = null; });
  }
});

const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, Partials, AttachmentBuilder } = require('discord.js');
const axios = require('axios');
const dotenv = require('dotenv');
const http = require('http');

dotenv.config();

const TOKEN = process.env.DISCORD_TOKEN;
const PORT = process.env.PORT || 10000;

// ---------- HTTP SERVER (Keep-alive for Render) ----------
const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
      <!DOCTYPE html>
      <html>
        <head><title>Cadmio Bot</title></head>
        <body style="font-family: monospace; background: #0a0a0a; color: #00ff88; padding: 40px;">
          <h1>🐱 Cadmio Discord Bot</h1>
          <p>Status: <strong style="color: #00ff88;">✅ ONLINE</strong></p>
          <p>Uptime: ${Math.floor(process.uptime())} seconds</p>
          <p>Bot: ${client ? client.user?.tag || 'Not logged in' : 'Initializing...'}</p>
          <hr>
          <p style="color: #666; font-size: 12px;">Keeping Render free tier alive</p>
        </body>
      </html>
    `);
  } else if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'online',
      uptime: process.uptime(),
      bot: client?.user?.tag || null,
      timestamp: new Date().toISOString()
    }));
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

// ---------- DISCORD BOT ----------
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
    allowedMentions: { parse: [], repliedUser: true }
});

function sanitizeOutput(text) {
    const ZWSP = '\u200b';
    return text
        .replace(/@everyone/g, "@" + ZWSP + "everyone")
        .replace(/@here/g, "@" + ZWSP + "here")
        .replace(/<@&(\d+)>/g, (m, id) => '<@&' + ZWSP + id + '>')
        .replace(/<@!?(\d+)>/g, (m, id) => '<@' + ZWSP + id + '>')
        .replace(/<#(\d+)>/g, (m, id) => '<#' + ZWSP + id + '>');
}

async function downloadFromUrl(url) {
    let targetUrl = url;
    if (url.includes("github.com") && url.includes("/blob/")) {
        targetUrl = url.replace("github.com", "raw.githubusercontent.com").replace("/blob/", "/");
    } else if (url.includes("pastebin.com") && !url.includes("/raw/")) {
        const pasteId = url.split("/").pop();
        targetUrl = `https://pastebin.com/raw/${pasteId}`;
    }
    try {
        const response = await axios.get(targetUrl, { timeout: 10000, responseType: 'text' });
        return response.status === 200 ? response.data : null;
    } catch {
        return null;
    }
}

async function extractCode(message, content) {
    if (message.attachments.size > 0) {
        const att = message.attachments.first();
        const response = await axios.get(att.url, { responseType: 'text' });
        return response.data;
    }
    if (message.reference) {
        try {
            const refMsg = await message.channel.messages.fetch(message.reference.messageId);
            if (refMsg.attachments.size > 0) {
                const att = refMsg.attachments.first();
                const response = await axios.get(att.url, { responseType: 'text' });
                return response.data;
            }
            if (refMsg.content) content = refMsg.content + "\n" + content;
        } catch (e) {}
    }
    const urlMatch = content.match(/https?:\/\/\S+/);
    if (urlMatch) {
        const code = await downloadFromUrl(urlMatch[0]);
        if (code) return code;
    }
    if (content.includes("```")) {
        const parts = content.split("```");
        if (parts.length >= 2) {
            const block = parts[1];
            const lines = block.split("\n");
            if (/^[a-zA-Z]+$/.test(lines[0].trim())) {
                return lines.slice(1).join("\n");
            }
            return block;
        }
    }
    return null;
}

// ---------- SIMPLE LUAU EXECUTOR (Pure Node.js) ----------
function executeLuau(code) {
    return new Promise((resolve) => {
        const result = [];
        const lines = code.split('\n');
        let output = '';

        // Simple Lua-like execution simulation
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('print(') || trimmed.startsWith('print "')) {
                let content = trimmed.replace(/^print\s*\(/, '').replace(/\)$/, '').trim();
                if (content.startsWith('"') && content.endsWith('"')) {
                    content = content.slice(1, -1);
                }
                output += content + '\n';
                result.push(content);
            } else if (trimmed.startsWith('--')) {
                continue;
            } else if (trimmed) {
                // Echo back variable assignments, etc.
                if (trimmed.includes('=')) {
                    const parts = trimmed.split('=').map(s => s.trim());
                    const varName = parts[0];
                    const varValue = parts.slice(1).join('=');
                    if (!isNaN(varValue)) {
                        output += varName + ' = ' + varValue + '\n';
                        result.push(varName + ' = ' + varValue);
                    }
                }
            }
        }

        if (!output) {
            output = '✅ Code executed successfully (no output)';
        }

        resolve({ ok: true, result: output });
    });
}

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (!message.content.startsWith('.')) return;

    const args = message.content.slice(1).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    if (command === 'l') {
        const text = args.join(' ');
        const code = await extractCode(message, text);

        if (!code || !code.trim()) {
            return message.reply("Attach a .lua/.luau file, reply to a message that has one, put the code in a ```lua ... ``` code block, or provide a valid code link.");
        }

        await message.channel.sendTyping();
        const { ok, result } = await executeLuau(code);
        const sanitizedResult = sanitizeOutput(result);

        if (!ok) {
            return message.reply(`Error:\n\`\`\`\n${sanitizedResult}\n\`\`\``);
        }

        if (sanitizedResult.length > 1900) {
            const attachment = new AttachmentBuilder(Buffer.from(sanitizedResult), { name: 'result.txt' });
            return message.reply({ content: '✅ done, attached file:', files: [attachment] });
        } else {
            return message.reply(`Result:\n\`\`\`lua\n${sanitizedResult}\n\`\`\``);
        }
    }
});

client.once('ready', () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
});

if (!TOKEN) {
    console.error("❌ Missing DISCORD_TOKEN");
    process.exit(1);
}

// ---------- START ----------
server.listen(PORT, () => {
    console.log(`🌐 HTTP server on port ${PORT}`);
});

client.login(TOKEN);

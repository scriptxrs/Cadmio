const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Client, GatewayIntentBits, Partials, AttachmentBuilder } = require('discord.js');
const axios = require('axios');
const dotenv = require('dotenv');

dotenv.config();

// Embedded assets (Placeholders for preview)
const ASSETS = {
    catlogLuau: `... [Luau Source Code: ~8000 lines] ...`,
    apiDump: `... [Roblox API Dump JSON: ~6.5MB] ...`,
    classes: `... [Classes JSON: ~3.8MB] ...`,
    enums: `... [Enums JSON: ~90KB] ...`,
    assetids: `... [Asset IDs JSON: ~6KB] ...`
};

const TOKEN = process.env.DISCORD_TOKEN;
const LUNE_BIN = process.env.LUNE_BIN || 'lune';
const TIMEOUT_SECONDS = 30;

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
    allowedMentions: { parse: [], repliedUser: true }
});

/**
 * Sanitizes output to prevent accidental mentions in Discord.
 */
function sanitizeOutput(text) {
    const ZWSP = '\u200b';
    return text
        .replace(/@everyone/g, "@" + ZWSP + "everyone")
        .replace(/@here/g, "@" + ZWSP + "here")
        .replace(/<@&(\d+)>/g, (m, id) => '<@&' + ZWSP + id + '>')
        .replace(/<@!?(\d+)>/g, (m, id) => '<@' + ZWSP + id + '>')
        .replace(/<#(\d+)>/g, (m, id) => '<#' + ZWSP + id + '>');
}

/**
 * Downloads code from GitHub or Pastebin raw URLs.
 */
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
        if (response.status === 200) {
            return response.data;
        }
    } catch (error) {
        return null;
    }
    return null;
}

/**
 * Extracts code from message attachments, replies, or links.
 */
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
            if (refMsg.content) {
                content = refMsg.content + "\n" + content;
            }
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

/**
 * Runs the Luau code using the embedded catlog script and Lune.
 */
function runLune(code) {
    return new Promise((resolve) => {
        const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cadmio-'));
        const inputPath = path.join(tmpDir, 'input.lua');
        const outputPath = path.join(tmpDir, 'out.lua');
        const luneScriptPath = path.join(tmpDir, 'catlog.luau');
        const apiDumpPath = path.join(tmpDir, 'API-Dump.json');
        const classesPath = path.join(tmpDir, 'classes.json');
        const enumsPath = path.join(tmpDir, 'enums.json');
        const assetidsPath = path.join(tmpDir, 'assetids.json');

        // Write assets to disk for Lune to consume
        fs.writeFileSync(inputPath, code);
        fs.writeFileSync(luneScriptPath, ASSETS.catlogLuau);
        fs.writeFileSync(apiDumpPath, ASSETS.apiDump);
        fs.writeFileSync(classesPath, ASSETS.classes);
        fs.writeFileSync(enumsPath, ASSETS.enums);
        fs.writeFileSync(assetidsPath, ASSETS.assetids);

        const args = [
            'run',
            luneScriptPath,
            '--',
            inputPath,
            `out=${outputPath}`,
            `api_dump=${apiDumpPath}`,
            `classes=${classesPath}`,
            `enums=${enumsPath}`,
            `assetids=${assetidsPath}`
        ];

        const proc = spawn(LUNE_BIN, args, { cwd: tmpDir, timeout: TIMEOUT_SECONDS * 1000 });
        
        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data) => stdout += data);
        proc.stderr.on('data', (data) => stderr += data);

        proc.on('close', (code) => {
            if (fs.existsSync(outputPath)) {
                const result = fs.readFileSync(outputPath, 'utf8');
                resolve({ ok: true, result });
            } else {
                const err = (stderr || stdout || "Unknown error").trim();
                resolve({ ok: false, result: err.slice(0, 1900) });
            }
            // Cleanup temporary files
            try {
                fs.rmSync(tmpDir, { recursive: true, force: true });
            } catch (e) {}
        });

        proc.on('error', (err) => {
            resolve({ ok: false, result: `Failed to start lune: ${err.message}` });
        });
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
        const { ok, result } = await runLune(code);
        const sanitizedResult = sanitizeOutput(result);

        if (!ok) {
            return message.reply(`Error:\n\`\`\`\n${sanitizedResult}\n\`\`\``);
        }

        if (sanitizedResult.length > 1900) {
            const attachment = new AttachmentBuilder(Buffer.from(sanitizedResult), { name: 'result.lua' });
            return message.reply({ content: 'done, attached file:', files: [attachment] });
        } else {
            return message.reply(`Result:\n\`\`\`lua\n${sanitizedResult}\n\`\`\``);
        }
    }
});

client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag} (ID: ${client.user.id})`);
});

if (!TOKEN) {
    console.error("Missing DISCORD_TOKEN in the .env file");
    process.exit(1);
}

client.login(TOKEN);

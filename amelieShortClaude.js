const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const dotenv = require('dotenv');
const winston = require('winston');
const Datastore = require('nedb');

dotenv.config();

const API_KEY = process.env.API_KEY;
const MAX_HISTORY = parseInt(process.env.MAX_HISTORY || '500');
let bot_name = process.env.BOT_NAME || 'Amelie';

const logger = winston.createLogger({
    level: 'debug',
    format: winston.format.simple(),
    transports: [new winston.transports.Console(), new winston.transports.File({ filename: 'bot.log' })]
});

const messagesDb = new Datastore({ filename: 'messages.db', autoload: true });
const promptsDb = new Datastore({ filename: 'prompts.db', autoload: true });
const configDb = new Datastore({ filename: 'config.db', autoload: true });

const genAI = new GoogleGenerativeAI(API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

const client = new Client({ authStrategy: new LocalAuth() });

client.on('qr', qr => qrcode.generate(qr, {small: true}));
client.on('ready', () => logger.info('WhatsApp client ready'));

client.on('message_create', async (msg) => {
    if (msg.fromMe) return;
    const chat = await msg.getChat();
    await chat.sendSeen();

    const chatId = chat.id._serialized;
    if (chat.isGroup && !(await shouldRespondInGroup(msg, chat))) return;

    try {
        if (msg.body.startsWith('!')) {
            await handleCommand(msg, chatId);
        } else if (msg.hasMedia) {
            const attachmentData = await msg.downloadMedia();
            if (attachmentData.mimetype.startsWith('audio/')) {
                await handleAudioMessage(msg, attachmentData, chatId);
            } else if (attachmentData.mimetype.startsWith('image/')) {
                await handleImageMessage(msg, attachmentData, chatId);
            } else {
                await msg.reply('Sorry, I can only process audio and images at the moment.');
            }
        } else {
            await handleTextMessage(msg);
        }
    } catch (error) {
        logger.error(`Error processing message: ${error.message}`, { error });
        await msg.reply('Sorry, an unexpected error occurred. Please try again later.');
    }
});

async function shouldRespondInGroup(msg, chat) {
    const mentions = await msg.getMentions();
    return mentions.some(mention => mention.id._serialized === client.info.wid._serialized) ||
           (msg.hasQuotedMsg && (await msg.getQuotedMessage()).fromMe) ||
           msg.body.toLowerCase().includes(bot_name.toLowerCase());
}

async function handleCommand(msg, chatId) {
    const [command, ...args] = msg.body.slice(1).split(' ');
    switch (command.toLowerCase()) {
        case 'reset':
            await resetHistory(chatId);
            await msg.reply('🤖 Chat history reset');
            break;
        case 'help':
            await msg.reply('Available commands: !reset, !prompt (set/get/list/use/clear), !config (set/get)');
            break;
        case 'prompt':
        case 'config':
            await handlePromptOrConfigCommand(msg, command, args, chatId);
            break;
        default:
            await msg.reply('Unknown command. Use !help to see available commands.');
    }
}

async function handlePromptOrConfigCommand(msg, command, args, chatId) {
    const [subcommand, name, ...rest] = args;
    const handlers = {
        prompt: {
            set: async () => {
                if (name && rest.length > 0) {
                    await setSystemPrompt(chatId, name, rest.join(' '));
                    await msg.reply(`System Instruction "${name}" set successfully.`);
                } else {
                    await msg.reply('Correct usage: !prompt set <name> <text>');
                }
            },
            get: async () => {
                if (name) {
                    const prompt = await getSystemPrompt(chatId, name);
                    await msg.reply(prompt ? `System Instruction "${name}":\n${prompt.text}` : `System Instruction "${name}" not found.`);
                } else {
                    await msg.reply('Correct usage: !prompt get <name>');
                }
            },
            list: async () => {
                const prompts = await listSystemPrompts(chatId);
                await msg.reply(prompts.length > 0 ? `Available System Instructions: ${prompts.map(p => p.name).join(', ')}` : 'No System Instructions defined.');
            },
            use: async () => {
                if (name) {
                    const success = await setActiveSystemPrompt(chatId, name);
                    await msg.reply(success ? `System Instruction "${name}" activated for this chat.` : `System Instruction "${name}" not found.`);
                } else {
                    await msg.reply('Correct usage: !prompt use <name>');
                }
            },
            clear: async () => {
                await clearActiveSystemPrompt(chatId);
                await msg.reply('System Instruction removed. Using default model.');
            }
        },
        config: {
            set: async () => {
                if (name && rest[0]) {
                    const value = parseFloat(rest[0]);
                    if (!isNaN(value) && ['temperature', 'topK', 'topP', 'maxOutputTokens'].includes(name)) {
                        await setConfig(chatId, name, value);
                        await msg.reply(`Parameter ${name} set to ${value}`);
                    } else {
                        await msg.reply(`Invalid value for ${name}. Use a number.`);
                    }
                } else {
                    await msg.reply('Correct usage: !config set <param> <value>');
                }
            },
            get: async () => {
                const config = await getConfig(chatId);
                const response = name ? 
                    (config.hasOwnProperty(name) ? `${name}: ${config[name]}` : `Unknown parameter: ${name}`) :
                    `Current configuration:\n${Object.entries(config).map(([k, v]) => `${k}: ${v}`).join('\n')}`;
                await msg.reply(response);
            }
        }
    };

    if (handlers[command] && handlers[command][subcommand]) {
        await handlers[command][subcommand]();
    } else {
        await msg.reply(`Unknown ${command} subcommand. Use !help to see available commands.`);
    }
}

async function handleTextMessage(msg) {
    const chatId = msg.from;
    const sender = msg.author || msg.from;
    await updateMessageHistory(chatId, sender, msg.body);
    const history = await getMessageHistory(chatId);
    const userPromptText = history.join('\n') + `\n${sender}: ${msg.body}\n${bot_name}:`;
    const response = await generateResponseWithText(userPromptText, chatId);
    await updateMessageHistory(chatId, bot_name, response, true);
    await sendLongMessage(msg, response);
}

async function handleAudioMessage(msg, audioData, chatId) {
    // Implement audio processing logic here
    await msg.reply('Audio processing not implemented in this simplified version.');
}

async function handleImageMessage(msg, imageData, chatId) {
    // Implement image processing logic here
    await msg.reply('Image processing not implemented in this simplified version.');
}

async function generateResponseWithText(userPrompt, chatId) {
    try {
        const userConfig = await getConfig(chatId);
        const chat = model.startChat(userConfig);
        if (userConfig.systemInstructions) {
            await chat.sendMessage(userConfig.systemInstructions);
        }
        const result = await chat.sendMessage(userPrompt);
        return result.response.text() || "Sorry, an error occurred while generating the response.";
    } catch (error) {
        logger.error(`Error generating text response: ${error.message}`, { error });
        return "Sorry, an error occurred. Please try again or rephrase your question.";
    }
}

function getMessageHistory(chatId) {
    return new Promise((resolve, reject) => {
        messagesDb.find({ chatId, type: { $in: ['user', 'bot'] } })
            .sort({ timestamp: -1 })
            .limit(MAX_HISTORY * 2)
            .exec((err, docs) => err ? reject(err) : resolve(docs.reverse().map(doc => `${doc.sender}: ${doc.content}`)));
    });
}

function updateMessageHistory(chatId, sender, message, isBot = false) {
    return new Promise((resolve, reject) => {
        messagesDb.insert({ chatId, sender, content: message, timestamp: Date.now(), type: isBot ? 'bot' : 'user' }, err => {
            if (err) reject(err);
            else {
                messagesDb.find({ chatId, type: { $in: ['user', 'bot'] } })
                    .sort({ timestamp: -1 })
                    .skip(MAX_HISTORY * 2)
                    .exec((err, docsToRemove) => {
                        if (err) reject(err);
                        else {
                            messagesDb.remove({ _id: { $in: docsToRemove.map(doc => doc._id) } }, { multi: true }, err => err ? reject(err) : resolve());
                        }
                    });
            }
        });
    });
}

function resetHistory(chatId) {
    return new Promise((resolve, reject) => {
        messagesDb.remove({ chatId, type: { $in: ['user', 'bot'] } }, { multi: true }, err => err ? reject(err) : resolve());
    });
}

// Implement other helper functions (setSystemPrompt, getSystemPrompt, listSystemPrompts, setActiveSystemPrompt, clearActiveSystemPrompt, setConfig, getConfig) similarly

async function sendLongMessage(msg, text) {
    try {
        const trimmedText = text.trim().replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n{3,}/g, '\n\n');
        await msg.reply(trimmedText);
    } catch (error) {
        logger.error(`Error sending message: ${error.message}`, { error });
        await msg.reply('Sorry, an error occurred while sending the response. Please try again.');
    }
}

client.initialize();

process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection at:', { promise, reason });
});

process.on('uncaughtException', (error) => {
    logger.error(`Uncaught Exception: ${error.message}`, { error });
    process.exit(1);
});
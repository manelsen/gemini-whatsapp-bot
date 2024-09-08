const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');
const dotenv = require('dotenv');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const winston = require('winston');
const Datastore = require('nedb');

dotenv.config();

// Configuração de variáveis de ambiente
const GOOGLE_AI_KEY = process.env.GOOGLE_AI_KEY;
const MAX_HISTORY = parseInt(process.env.MAX_HISTORY || '500');
const BOT_NAME = process.env.BOT_NAME || 'Amelie';
const userSessions = new Map();

// Configuração do logger
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'bot.log' })
    ]
});

// Configuração do NeDB
const messagesDb = new Datastore({ filename: 'messages.db', autoload: true });
const promptsDb = new Datastore({ filename: 'prompts.db', autoload: true });
const configDb = new Datastore({ filename: 'config.db', autoload: true });

// Configuração da IA do Google
const genAI = new GoogleGenerativeAI(GOOGLE_AI_KEY);
const textModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
const imageModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// Configuração padrão
const defaultConfig = {
    temperature: 0.7,
    topK: 40,
    topP: 0.95,
    maxOutputTokens: 1024,
};

// Configuração do cliente WhatsApp
const client = new Client({
    authStrategy: new LocalAuth()
});

client.on('qr', qr => {
    qrcode.generate(qr, {small: true});
    logger.info('QR code gerado');
});

client.on('ready', () => {
    logger.info('Cliente WhatsApp pronto');
});

client.on('message_create', async (msg) => {
    try {
        if (msg.fromMe) return;

        const chat = await msg.getChat();
        await chat.sendSeen();

        if (chat.isGroup) {
            const shouldRespond = await shouldRespondInGroup(msg, chat);
            if (!shouldRespond) return;
        }

        if (msg.body.startsWith('!')) {
            await handleCommand(msg);
        } else if (msg.hasMedia) {
            const attachmentData = await msg.downloadMedia();
            if (attachmentData.mimetype.startsWith('image/')) {
                await handleImageMessage(msg, attachmentData);
            } else {
                await msg.reply('Desculpe, no momento só posso processar imagens.');
            }
        } else {
            await handleTextMessage(msg);
        }
    } catch (error) {
        logger.error('Erro ao processar mensagem:', error);
        await msg.reply('Desculpe, ocorreu um erro inesperado. Por favor, tente novamente mais tarde.');
    }
});

async function shouldRespondInGroup(msg, chat) {
    const mentions = await msg.getMentions();
    const isBotMentioned = mentions.some(mention => mention.id._serialized === client.info.wid._serialized);

    let isReplyToBot = false;
    if (msg.hasQuotedMsg) {
        const quotedMsg = await msg.getQuotedMessage();
        isReplyToBot = quotedMsg.fromMe;
    }

    const isBotNameMentioned = msg.body.toLowerCase().includes(BOT_NAME.toLowerCase());

    return isBotMentioned || isReplyToBot || isBotNameMentioned;
}

async function handleMessage(msg) {
    const userId = msg.from;
    let session = userSessions.get(userId);
    
    if (!session) {
        session = { introductionGiven: false };
        userSessions.set(userId, session);
    }

    let response = '';
    
    if (!session.introductionGiven) {
        response += "Olá! 😊 Sou a Dra. Amelie, uma androide programada para oferecer apoio e suporte a pessoas neurodivergentes. Estou aqui para te ouvir, te ajudar e te dar um abraço virtual se precisar. 🤗\n\n";
        session.introductionGiven = true;
    }

    // Gere a resposta específica para a mensagem do usuário
    const specificResponse = await generateResponse(msg.body);
    response += specificResponse;

    await msg.reply(response);
}

// Função para resetar a sessão após um período de inatividade
function resetSessionAfterInactivity(userId, inactivityPeriod = 3600000) { // 1 hora
    setTimeout(() => {
        userSessions.delete(userId);
    }, inactivityPeriod);
}

function resetSessionAfterInactivity(userId, inactivityPeriod = 3600000) { // 1 hora
    setTimeout(() => {
        userSessions.delete(userId);
    }, inactivityPeriod);
}

client.initialize();

// Chame esta função após cada mensagem processada
resetSessionAfterInactivity(msg.from);

async function handleCommand(msg) {
    const [command, ...args] = msg.body.slice(1).split(' ');
    switch (command.toLowerCase()) {
        case 'reset':
            await resetHistory(msg.from);
            await msg.reply('🤖 Histórico resetado para este chat');
            break;
        case 'help':
            await msg.reply(
                'Comandos disponíveis:\n' +
                '!reset - Limpa o histórico de conversa\n' +
                '!prompt set <nome> <texto> - Define um novo system prompt\n' +
                '!prompt get <nome> - Mostra um system prompt existente\n' +
                '!prompt list - Lista todos os system prompts\n' +
                '!prompt use <nome> - Usa um system prompt específico\n' +
                '!config set <param> <valor> - Define um parâmetro de configuração\n' +
                '!config get [param] - Mostra a configuração atual\n' +
                '!help - Mostra esta mensagem de ajuda'
            );
            break;
        case 'prompt':
            await handlePromptCommand(msg, args);
            break;
        case 'config':
            await handleConfigCommand(msg, args);
            break;
        default:
            await msg.reply('Comando desconhecido. Use !help para ver os comandos disponíveis.');
    }
}

async function handlePromptCommand(msg, args) {
    const [subcommand, name, ...rest] = args;
    switch (subcommand) {
        case 'set':
            if (name && rest.length > 0) {
                const promptText = rest.join(' ');
                await setSystemPrompt(name, promptText);
                await msg.reply(`System prompt "${name}" definido com sucesso.`);
            } else {
                await msg.reply('Uso correto: !prompt set <nome> <texto>');
            }
            break;
        case 'get':
            if (name) {
                const prompt = await getSystemPrompt(name);
                if (prompt) {
                    await msg.reply(`System prompt "${name}":\n${prompt.text}`);
                } else {
                    await msg.reply(`System prompt "${name}" não encontrado.`);
                }
            } else {
                await msg.reply('Uso correto: !prompt get <nome>');
            }
            break;
        case 'list':
            const prompts = await listSystemPrompts();
            if (prompts.length > 0) {
                const promptList = prompts.map(p => p.name).join(', ');
                await msg.reply(`System prompts disponíveis: ${promptList}`);
            } else {
                await msg.reply('Nenhum system prompt definido.');
            }
            break;
        case 'use':
            if (name) {
                const prompt = await getSystemPrompt(name);
                if (prompt) {
                    await setActiveSystemPrompt(msg.from, name);
                    await msg.reply(`System prompt "${name}" ativado para este chat.`);
                } else {
                    await msg.reply(`System prompt "${name}" não encontrado.`);
                }
            } else {
                await msg.reply('Uso correto: !prompt use <nome>');
            }
            break;
        default:
            await msg.reply('Subcomando de prompt desconhecido. Use !help para ver os comandos disponíveis.');
    }
}

async function handleConfigCommand(msg, args) {
    const [subcommand, param, value] = args;
    const userId = msg.from;

    switch (subcommand) {
        case 'set':
            if (param && value) {
                if (['temperature', 'topK', 'topP', 'maxOutputTokens'].includes(param)) {
                    const numValue = parseFloat(value);
                    if (!isNaN(numValue)) {
                        await setConfig(userId, param, numValue);
                        await msg.reply(`Parâmetro ${param} definido como ${numValue}`);
                    } else {
                        await msg.reply(`Valor inválido para ${param}. Use um número.`);
                    }
                } else {
                    await msg.reply(`Parâmetro desconhecido: ${param}`);
                }
            } else {
                await msg.reply('Uso correto: !config set <param> <valor>');
            }
            break;
        case 'get':
            const config = await getConfig(userId);
            if (param) {
                if (config.hasOwnProperty(param)) {
                    await msg.reply(`${param}: ${config[param]}`);
                } else {
                    await msg.reply(`Parâmetro desconhecido: ${param}`);
                }
            } else {
                const configString = Object.entries(config)
                    .map(([key, value]) => `${key}: ${value}`)
                    .join('\n');
                await msg.reply(`Configuração atual:\n${configString}`);
            }
            break;
        default:
            await msg.reply('Subcomando de config desconhecido. Use !help para ver os comandos disponíveis.');
    }
}

async function handleTextMessage(msg) {
    try {
        const userId = msg.from;
        let session = userSessions.get(userId);
        
        if (!session) {
            session = { introductionGiven: false };
            userSessions.set(userId, session);
        }

        let response = '';
        
        if (!session.introductionGiven) {
            response += "Olá! 😊 Sou a Dra. Amelie, uma androide programada para oferecer apoio e suporte a pessoas neurodivergentes. Estou aqui para te ouvir, te ajudar e te dar um abraço virtual se precisar. 🤗\n\n";
            session.introductionGiven = true;
        }

        const history = await getMessageHistory(userId);
        const activePrompt = await getActiveSystemPrompt(userId);
        
        const systemPromptText = activePrompt ? activePrompt.text : "";
        const userPromptText = history.join('\n\n') + '\n\n' + msg.body;
        
        const specificResponse = await generateResponseWithText(systemPromptText, userPromptText, userId);
        response += specificResponse;
        
        await updateMessageHistory(userId, msg.body, response);
        await sendLongMessage(msg, response);
    } catch (error) {
        logger.error('Erro ao processar mensagem de texto:', error);
        await msg.reply('Desculpe, não foi possível processar sua mensagem. Por favor, tente novamente.');
    }
}

async function handleImageMessage(msg, imageData) {
    try {
        const caption = msg.body || "O que há nesta imagem?";
        const response = await generateResponseWithImageAndText(imageData.data, caption);
        await sendLongMessage(msg, response);
    } catch (error) {
        logger.error('Erro ao processar imagem:', error);
        await msg.reply('Desculpe, não foi possível processar sua imagem. Por favor, tente novamente.');
    }
}

async function generateResponseWithText(systemPrompt, userPrompt, userId) {
    try {
        const config = await getConfig(userId);
        const result = await textModel.generateContent({
            contents: [
                { role: "user", parts: [{ text: systemPrompt }] },
                { role: "model", parts: [{ text: "Entendido. Vou seguir essas instruções." }] },
                { role: "user", parts: [{ text: userPrompt }] }
            ],
            generationConfig: config,
        });
        return result.response.text();
    } catch (error) {
        logger.error('Erro ao gerar resposta de texto:', error);
        throw new Error("Falha ao gerar resposta de texto");
    }
}

async function generateResponseWithImageAndText(imageData, text) {
    try {
        const imageParts = [
            {
                inlineData: {
                    data: imageData.toString('base64'),
                    mimeType: 'image/jpeg'
                }
            }
        ];
        const result = await imageModel.generateContent([imageParts[0], text]);
        return result.response.text();
    } catch (error) {
        logger.error('Erro ao gerar resposta de imagem:', error);
        throw new Error("Falha ao processar a imagem");
    }
}

function getMessageHistory(userId) {
    return new Promise((resolve, reject) => {
        messagesDb.find({ userId: userId, type: { $in: ['user', 'bot'] } })
          .sort({ timestamp: -1 })
          .limit(MAX_HISTORY * 2)
          .exec((err, docs) => {
            if (err) reject(err);
            else resolve(docs.reverse().map(doc => doc.content));
          });
    });
}

function updateMessageHistory(userId, userMessage, botResponse) {
    return new Promise((resolve, reject) => {
        messagesDb.insert([
            { userId, content: userMessage, timestamp: Date.now(), type: 'user' },
            { userId, content: botResponse, timestamp: Date.now(), type: 'bot' }
        ], (err) => {
            if (err) reject(err);
            else {
                messagesDb.find({ userId: userId, type: { $in: ['user', 'bot'] } })
                  .sort({ timestamp: -1 })
                  .skip(MAX_HISTORY * 2)
                  .exec((err, docsToRemove) => {
                    if (err) reject(err);
                    else {
                        messagesDb.remove({ _id: { $in: docsToRemove.map(doc => doc._id) } }, { multi: true }, (err) => {
                            if (err) reject(err);
                            else resolve();
                        });
                    }
                  });
            }
        });
    });
}

function resetHistory(userId) {
    return new Promise((resolve, reject) => {
        messagesDb.remove({ userId: userId, type: { $in: ['user', 'bot'] } }, { multi: true }, (err) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

function setSystemPrompt(name, text) {
    return new Promise((resolve, reject) => {
        promptsDb.update({ name }, { name, text }, { upsert: true }, (err) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

function getSystemPrompt(name) {
    return new Promise((resolve, reject) => {
        promptsDb.findOne({ name }, (err, doc) => {
            if (err) reject(err);
            else resolve(doc);
        });
    });
}

function listSystemPrompts() {
    return new Promise((resolve, reject) => {
        promptsDb.find({}, (err, docs) => {
            if (err) reject(err);
            else resolve(docs);
        });
    });
}

function setActiveSystemPrompt(userId, promptName) {
    return new Promise((resolve, reject) => {
        messagesDb.update({ userId, type: 'activePrompt' }, { userId, type: 'activePrompt', promptName }, { upsert: true }, (err) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

function getActiveSystemPrompt(userId) {
    return new Promise((resolve, reject) => {
        messagesDb.findOne({ userId, type: 'activePrompt' }, (err, doc) => {
            if (err) reject(err);
            else if (doc) {
                getSystemPrompt(doc.promptName).then(resolve).catch(reject);
            } else {
                resolve(null);
            }
        });
    });
}

function setConfig(userId, param, value) {
    return new Promise((resolve, reject) => {
        configDb.update(
            { userId },
            { $set: { [param]: value } },
            { upsert: true },
            (err) => {
                if (err) reject(err);
                else resolve();
            }
        );
    });
}

async function getConfig(userId) {
    return new Promise((resolve, reject) => {
        configDb.findOne({ userId }, (err, doc) => {
            if (err) reject(err);
            else resolve({ ...defaultConfig, ...(doc || {}) });
        });
    });
}

async function sendLongMessage(msg, text) {
    try {
        // Remove qualquer quebra de linha extra no início ou fim do texto
        let trimmedText = text.trim();
        
        // Substitui todas as ocorrências de CRLF (\r\n) por LF (\n)
        trimmedText = trimmedText.replace(/\r\n/g, '\n');
        
        // Substitui quaisquer CRs (\r) remanescentes por LFs (\n)
        trimmedText = trimmedText.replace(/\r/g, '\n');
        
        // Remove quaisquer linhas em branco extras
        trimmedText = trimmedText.replace(/\n{3,}/g, '\n\n');
        
        // Envia todo o texto como uma única mensagem
        await msg.reply(trimmedText);
    } catch (error) {
        logger.error('Erro ao enviar mensagem:', error);
        await msg.reply('Desculpe, ocorreu um erro ao enviar a resposta. Por favor, tente novamente.');
    }
}

client.initialize();

process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception:', error);
    process.exit(1);
});

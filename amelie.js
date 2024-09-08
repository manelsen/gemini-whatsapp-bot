const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { FileManager } = require("@google/generative-ai/lib/types/file");
const dotenv = require('dotenv');
const winston = require('winston');
const Datastore = require('nedb');
const fs = require('fs').promises;

dotenv.config();

// Configuração de variáveis de ambiente
const API_KEY = process.env.API_KEY;
const MAX_HISTORY = parseInt(process.env.MAX_HISTORY || '500');
const BOT_NAME = process.env.BOT_NAME || 'Amelie';

// Configuração do logger
const logger = winston.createLogger({
    level: 'debug',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message, ...rest }) => {
            const extraData = Object.keys(rest).length ? JSON.stringify(rest, null, 2) : '';
            return `${timestamp} [${level}]: ${message} ${extraData}`;
        })
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

// Inicialização do GoogleGenerativeAI
const genAI = new GoogleGenerativeAI(API_KEY);

// Inicialização do FileManager
const fileManager = new FileManager(API_KEY);

// Inicialização do modelo Gemini
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// Mapa para armazenar modelos com System Instructions
const userModels = new Map();

// Mapa para armazenar as últimas respostas por chat
const lastResponses = new Map();

// Configuração padrão
const defaultConfig = {
    temperature: 1.2,
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

        logger.info(`Mensagem recebida: ${msg.author} -> ${msg.body}`);

        const chatId = chat.id._serialized;

        if (chat.isGroup) {
            const shouldRespond = await shouldRespondInGroup(msg, chat);
            if (!shouldRespond) return;
        }

        if (msg.body.startsWith('!')) {
            logger.info(`Comando detectado: ${msg.body}`);
            await handleCommand(msg, chatId);
        } else if (msg.hasMedia) {
            const attachmentData = await msg.downloadMedia();
            if (attachmentData.mimetype === 'audio/ogg; codecs=opus') {
                await handleAudioMessage(msg, attachmentData, chatId);
            } else if (attachmentData.mimetype.startsWith('image/')) {
                await handleImageMessage(msg, attachmentData, chatId);
            } else {
                await msg.reply('Desculpe, no momento só posso processar áudios nativos do WhatsApp e imagens.');
            }
        } else {
            await handleTextMessage(msg);
        }

        resetSessionAfterInactivity(chatId);
    } catch (error) {
        logger.error(`Erro ao processar mensagem: ${error.message}`, { error });
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

async function handleCommand(msg, chatId) {
    const [command, ...args] = msg.body.slice(1).split(' ');
    logger.info(`Comando: ${command}, Argumentos: ${args}`);

    try {
        switch (command.toLowerCase()) {
            case 'reset':
                await resetHistory(chatId);
                await msg.reply('🤖 Histórico resetado para este chat');
                break;
            case 'help':
                await msg.reply(
                    'Comandos disponíveis:\n' +
                    '!reset - Limpa o histórico de conversa\n' +
                    '!prompt set <nome> <texto> - Define uma nova System Instruction\n' +
                    '!prompt get <nome> - Mostra uma System Instruction existente\n' +
                    '!prompt list - Lista todas as System Instructions\n' +
                    '!prompt use <nome> - Usa uma System Instruction específica\n' +
                    '!prompt clear - Remove a System Instruction ativa\n' +
                    '!config set <param> <valor> - Define um parâmetro de configuração\n' +
                    '!config get [param] - Mostra a configuração atual\n' +
                    '!help - Mostra esta mensagem de ajuda'
                );
                break;
            case 'prompt':
                await handlePromptCommand(msg, args, chatId);
                break;
            case 'config':
                await handleConfigCommand(msg, args, chatId);
                break;
            default:
                await msg.reply('Comando desconhecido. Use !help para ver os comandos disponíveis.');
        }
    } catch (error) {
        logger.error(`Erro ao executar comando: ${error.message}`, { error });
        await msg.reply('Desculpe, ocorreu um erro ao executar o comando. Por favor, tente novamente.');
    }
}

async function handleTextMessage(msg) {
    try {
        const chatId = msg.from;
        const sender = msg.author || msg.from;

        await updateMessageHistory(chatId, sender, msg.body);

        const history = await getMessageHistory(chatId);

        const model = getModelForUser(chatId);

        const userPromptText = history.join('\n') + `\n${sender}: ${msg.body}\n${BOT_NAME}:`;

        logger.info(`Gerando resposta para: ${userPromptText}`);
        const response = await generateResponseWithText(model, userPromptText, chatId);
        logger.info(`Resposta gerada: ${response}`);

        const lastResponse = lastResponses.get(chatId);
        if (lastResponse && isSimilar(response, lastResponse)) {
            response = "Desculpe, parece que já respondi a essa pergunta. Tente perguntar algo diferente.";
        }

        lastResponses.set(chatId, response);

        if (!response || response.trim() === '') {
            response = "Desculpe, ocorreu um erro ao gerar a resposta. Por favor, tente novamente.";
        }

        await updateMessageHistory(chatId, BOT_NAME, response, true);
        await sendLongMessage(msg, response);
    } catch (error) {
        logger.error(`Erro ao processar mensagem de texto: ${error.message}`, { error });
        await msg.reply('Desculpe, ocorreu um erro ao processar sua mensagem. Por favor, tente novamente.');
    }
}

async function handleAudioMessage(msg, audioData, chatId) {
    try {
        let audioFile;
        const isLargeFile = audioData.data.length > 20 * 1024 * 1024; // 20MB

        if (isLargeFile) {
            // Salvar temporariamente e fazer upload para arquivos grandes
            const tempFilePath = `./temp_audio_${chatId}.ogg`;
            await fs.writeFile(tempFilePath, audioData.data);
            audioFile = await uploadAudioFile(tempFilePath, 'audio/ogg');
            await fs.unlink(tempFilePath); // Remover arquivo temporário
        }

        const prompt = "Por favor, transcreva o áudio e depois resuma o conteúdo em português.";

        let result;
        if (isLargeFile) {
            result = await model.generateContent([
                {
                    fileData: {
                        mimeType: audioFile.file.mimeType,
                        fileUri: audioFile.file.uri
                    }
                },
                { text: prompt },
            ]);
        } else {
            // Uso direto para arquivos pequenos
            result = await model.generateContent([
                {
                    inlineData: {
                        mimeType: 'audio/ogg',
                        data: audioData.data.toString('base64')
                    }
                },
                { text: prompt },
            ]);
        }

        const response = result.response.text();
        await sendLongMessage(msg, response);

        if (isLargeFile) {
            // Deletar o arquivo após o uso
            await fileManager.deleteFile(audioFile.name);
        }

    } catch (error) {
        console.error("Erro ao processar mensagem de áudio:", error);
        await msg.reply('Desculpe, ocorreu um erro ao processar o áudio. Por favor, tente novamente.');
    }
}

async function handleImageMessage(msg, imageData, chatId) {
    try {
        const caption = msg.body || "O que há nesta imagem?";
        const result = await model.generateContent([
            {
                inlineData: {
                    mimeType: imageData.mimetype,
                    data: imageData.data.toString('base64')
                }
            },
            { text: caption },
        ]);
        const response = result.response.text();
        await sendLongMessage(msg, response);
    } catch (error) {
        logger.error(`Erro ao processar imagem: ${error.message}`, { error });
        await msg.reply('Desculpe, não foi possível processar sua imagem. Por favor, tente novamente.');
    }
}

async function generateResponseWithText(model, userPrompt, chatId) {
    try {
        const userConfig = await getConfig(chatId);

        const validConfigKeys = ['temperature', 'topK', 'topP', 'maxOutputTokens'];
        const filteredConfig = Object.fromEntries(
            Object.entries(userConfig).filter(([key]) => validConfigKeys.includes(key))
        );

        logger.debug('Configuração filtrada:', { config: filteredConfig });

        const result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: userPrompt }] }],
            generationConfig: filteredConfig,
        });

        const responseText = result.response.text();

        if (!responseText) {
            throw new Error('Resposta vazia gerada pelo modelo');
        }

        return responseText;
    } catch (error) {
        logger.error(`Erro ao gerar resposta de texto: ${error.message}`, { error });

        if (error.message.includes('SAFETY')) {
            return "Desculpe, não posso gerar uma resposta para essa solicitação devido a restrições de segurança. Por favor, tente reformular sua pergunta de uma maneira diferente.";
        }

        return "Desculpe, ocorreu um erro ao gerar a resposta. Por favor, tente novamente ou reformule sua pergunta.";
    }
}

// Funções auxiliares
async function uploadAudioFile(filePath, mimeType) {
    try {
        const file = await fileManager.upload(filePath, { mimeType });
        return file;
    } catch (error) {
        console.error("Erro ao fazer upload do arquivo:", error);
        throw error;
    }
}

function getMessageHistory(chatId) {
    return new Promise((resolve, reject) => {
        messagesDb.find({ chatId: chatId, type: { $in: ['user', 'bot'] } })
            .sort({ timestamp: -1 })
            .limit(MAX_HISTORY * 2)
            .exec((err, docs) => {
                if (err) reject(err);
                else resolve(docs.reverse().map(doc => `${doc.sender}: ${doc.content}`));
            });
    });
}

function updateMessageHistory(chatId, sender, message, isBot = false) {
    return new Promise((resolve, reject) => {
        messagesDb.insert({
            chatId,
            sender,
            content: message,
            timestamp: Date.now(),
            type: isBot ? 'bot' : 'user'
        }, (err) => {
            if (err) reject(err);
            else {
                messagesDb.find({ chatId: chatId, type: { $in: ['user', 'bot'] } })
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

function resetHistory(chatId) {
    return new Promise((resolve, reject) => {
        messagesDb.remove({ chatId: chatId, type: { $in: ['user', 'bot'] } }, { multi: true }, (err) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

async function handlePromptCommand(msg, args, chatId) {
    const [subcommand, name, ...rest] = args;

    switch (subcommand) {
        case 'set':
            if (name && rest.length > 0) {
                const promptText = rest.join(' ');
                await setSystemPrompt(chatId, name, promptText);
                await msg.reply(`System Instruction "${name}" definida com sucesso.`);
            } else {
                await msg.reply('Uso correto: !prompt set <nome> <texto>');
            }
            break;
        case 'get':
            if (name) {
                const prompt = await getSystemPrompt(chatId, name);
                if (prompt) {
                    await msg.reply(`System Instruction "${name}":\n${prompt.text}`);
                } else {
                    await msg.reply(`System Instruction "${name}" não encontrada.`);
                }
            } else {
                await msg.reply('Uso correto: !prompt get <nome>');
            }
            break;
        case 'list':
            const prompts = await listSystemPrompts(chatId);
            if (prompts.length > 0) {
                const promptList = prompts.map(p => p.name).join(', ');
                await msg.reply(`System Instructions disponíveis: ${promptList}`);
            } else {
                await msg.reply('Nenhuma System Instruction definida.');
            }
            break;
        case 'use':
            if (name) {
                const prompt = await getSystemPrompt(chatId, name);
                if (prompt) {
                    await setActiveSystemPrompt(chatId, name);
                    await msg.reply(`System Instruction "${name}" ativada para este chat.`);
                } else {
                    await msg.reply(`System Instruction "${name}" não encontrada.`);
                }
            } else {
                await msg.reply('Uso correto: !prompt use <nome>');
            }
            break;
        case 'clear':
            await clearActiveSystemPrompt(chatId);
            await msg.reply('System Instruction removida. Usando o modelo padrão.');
            break;
        default:
            await msg.reply('Subcomando de prompt desconhecido. Use !help para ver os comandos disponíveis.');
    }
}

async function handleConfigCommand(msg, args, chatId) {
    const [subcommand, param, value] = args;

    switch (subcommand) {
        case 'set':
            if (param && value) {
                if (['temperature', 'topK', 'topP', 'maxOutputTokens'].includes(param)) {
                    const numValue = parseFloat(value);
                    if (!isNaN(numValue)) {
                        await setConfig(chatId, param, numValue);
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
            const config = await getConfig(chatId);
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

function setSystemPrompt(chatId, name, text) {
    return new Promise((resolve, reject) => {
        promptsDb.update({ chatId, name }, { chatId, name, text }, { upsert: true }, (err) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

function getSystemPrompt(chatId, name) {
    return new Promise((resolve, reject) => {
        promptsDb.findOne({ chatId, name }, (err, doc) => {
            if (err) reject(err);
            else resolve(doc);
        });
    });
}

function listSystemPrompts(chatId) {
    return new Promise((resolve, reject) => {
        promptsDb.find({ chatId }, (err, docs) => {
            if (err) reject(err);
            else resolve(docs);
        });
    });
}

function setActiveSystemPrompt(chatId, promptName) {
    return new Promise((resolve, reject) => {
        getSystemPrompt(chatId, promptName).then(prompt => {
            if (prompt) {
                const model = genAI.getGenerativeModel({
                    model: "gemini-1.5-flash",
                    generationConfig: defaultConfig,
                    safetySettings: [
                        {
                            category: "HARM_CATEGORY_HARASSMENT",
                            threshold: "BLOCK_NONE",
                        },
                        {
                            category: "HARM_CATEGORY_HATE_SPEECH",
                            threshold: "BLOCK_NONE",
                        },
                        {
                            category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
                            threshold: "BLOCK_NONE",
                        },
                        {
                            category: "HARM_CATEGORY_DANGEROUS_CONTENT",
                            threshold: "BLOCK_NONE",
                        },
                    ],
                    systemInstruction: prompt.text,
                });
                userModels.set(chatId, model);
                messagesDb.update(
                    { chatId, type: 'activePrompt' },
                    { chatId, type: 'activePrompt', promptName },
                    { upsert: true },
                    (err) => {
                        if (err) reject(err);
                        else resolve();
                    }
                );
            } else {
                reject(new Error('System Instruction não encontrada'));
            }
        }).catch(reject);
    });
}

function clearActiveSystemPrompt(chatId) {
    return new Promise((resolve, reject) => {
        userModels.delete(chatId);
        messagesDb.remove({ chatId, type: 'activePrompt' }, {}, (err) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

function getModelForUser(chatId) {
    return userModels.get(chatId) || model;
}

function setConfig(chatId, param, value) {
    return new Promise((resolve, reject) => {
        configDb.update(
            { chatId },
            { $set: { [param]: value } },
            { upsert: true },
            (err) => {
                if (err) reject(err);
                else resolve();
            }
        );
    });
}

async function getConfig(chatId) {
    return new Promise((resolve, reject) => {
        configDb.findOne({ chatId }, (err, doc) => {
            if (err) reject(err);
            else {
                const validConfigKeys = ['temperature', 'topK', 'topP', 'maxOutputTokens'];
                const userConfig = doc || {};
                const filteredConfig = {};

                for (const key of validConfigKeys) {
                    if (userConfig.hasOwnProperty(key)) {
                        filteredConfig[key] = userConfig[key];
                    } else if (defaultConfig.hasOwnProperty(key)) {
                        filteredConfig[key] = defaultConfig[key];
                    }
                }

                resolve(filteredConfig);
            }
        });
    });
}

async function sendLongMessage(msg, text) {
    try {
        if (!text || typeof text !== 'string' || text.trim() === '') {
            logger.error('Tentativa de enviar mensagem inválida:', { text });
            text = "Desculpe, ocorreu um erro ao gerar a resposta. Por favor, tente novamente.";
        }

        let trimmedText = text.trim();
        trimmedText = trimmedText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n{3,}/g, '\n\n');

        logger.debug('Enviando mensagem:', { text: trimmedText });
        await msg.reply(trimmedText);
    } catch (error) {
        logger.error(`Erro ao enviar mensagem: ${error.message}`, { error });
        await msg.reply('Desculpe, ocorreu um erro ao enviar a resposta. Por favor, tente novamente.');
    }
}

function resetSessionAfterInactivity(chatId, inactivityPeriod = 3600000) { // 1 hora
    setTimeout(() => {
        logger.info(`Sessão resetada para o chat ${chatId} após inatividade`);
    }, inactivityPeriod);
}

function isSimilar(text1, text2) {
    // Implemente sua lógica de comparação de similaridade aqui
    // Você pode usar algoritmos como Levenshtein distance, cosine similarity, etc.
    return false; // Placeholder
}

client.initialize();

process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection at:', { promise, reason });
});

process.on('uncaughtException', (error) => {
    logger.error(`Uncaught Exception: ${error.message}`, { error });
    process.exit(1);
});
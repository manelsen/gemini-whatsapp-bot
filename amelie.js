const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { GoogleAIFileManager } = require("@google/generative-ai/server");
const dotenv = require('dotenv');
const winston = require('winston');
const Datastore = require('nedb');
const fs = require('fs').promises;
const path = require('path');

dotenv.config();

// Configuração de variáveis de ambiente
const API_KEY = process.env.API_KEY;
const MAX_HISTORY = parseInt(process.env.MAX_HISTORY || '500');
let bot_name = process.env.BOT_NAME || 'Amelie';

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

// Inicialização do modelo Gemini
const model = genAI.getGenerativeModel({ 
    model: "gemini-1.5-flash",
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
    ]
  });

// Inicialização do FileManager
const fileManager = new GoogleAIFileManager(API_KEY);

// Mapa para armazenar as últimas respostas por chat
const lastResponses = new Map();

// Configuração padrão
const defaultConfig = {
    temperature: 0.9,
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
    logger.info('Cliente WhatsApp pronto e conectado');
    // Adicione mais informações sobre o estado do cliente aqui
});

client.on('message_create', async (msg) => {
    try {
        if (msg.fromMe) return;

        const chat = await msg.getChat();
        await chat.sendSeen();

        logger.info(`Mensagem recebida: User (identificado no Whatsapp como ${msg.from}) -> ${msg.body}`);

        const chatId = chat.id._serialized;

        if (chat.isGroup) {
            const shouldRespond = await shouldRespondInGroup(msg, chat);
            if (!shouldRespond && !msg.hasMedia) return;
        }

        if (msg.body.startsWith('!')) {
            logger.info(`Comando detectado: ${msg.body}`);
            await handleCommand(msg, chatId);
        } else if (msg.hasMedia) {
            const attachmentData = await msg.downloadMedia();
            if (attachmentData.mimetype === 'audio/ogg; codecs=opus' || 
                attachmentData.mimetype === 'audio/mp3' || 
                attachmentData.mimetype.startsWith('audio/')) {
                await handleAudioMessage(msg, attachmentData, chatId);
            } else if (attachmentData.mimetype.startsWith('image/')) {
                await handleImageMessage(msg, attachmentData, chatId);
            } else {
                await msg.reply('Desculpe, no momento só posso processar áudios e imagens.');
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

    const isBotNameMentioned = msg.body.toLowerCase().includes(bot_name.toLowerCase());

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

        const userPromptText = `Histórico de chat: (formato: número de whatsapp e em seguida mensagem; responda à última mensagem)\n\n${history.join('\n')}`;

        logger.info(`Gerando resposta para: ${userPromptText}`);
        const response = await generateResponseWithText(userPromptText, chatId);
        logger.info(`Resposta gerada: ${response}`);

        const lastResponse = lastResponses.get(chatId);
        if (lastResponse && isSimilar(response, lastResponse)) {
            response = "Desculpe, parece que já respondi a essa pergunta. Tente perguntar algo diferente.";
        }

        lastResponses.set(chatId, response);

        if (!response || response.trim() === '') {
            response = "Desculpe, ocorreu um erro ao gerar a resposta. Por favor, tente novamente.";
        }

        await updateMessageHistory(chatId, bot_name, response, true);
        await sendLongMessage(msg, response);
    } catch (error) {
        logger.error(`Erro ao processar mensagem de texto: ${error.message}`, { error });
        await msg.reply('Desculpe, ocorreu um erro ao processar sua mensagem. Por favor, tente novamente.');
    }
}

async function handleAudioMessage(msg, audioData, chatId) {
    try {
        const tempFilePath = path.join(__dirname, `temp_audio_${path.extname(audioData.filename || '.mp3')}`);
        await fs.writeFile(tempFilePath, audioData.data);

        logger.info(`Processando arquivo de áudio: ${tempFilePath}`);

        console.log("Pause");
        // Upload do arquivo usando o File API
        const uploadedFile = await fileManager.uploadFile(tempFilePath, {
            mimeType: audioData.mimetype || 'audio/mp3',
        });

        logger.info(`Arquivo de áudio enviado com sucesso: ${uploadedFile.file.uri}`);

        // Gerar conteúdo usando o modelo (com tratamento de erros)
        try {
            const result = await model.generateContent([
                {
                    fileData: {
                        mimeType: uploadedFile.file.mimeType,
                        fileUri: uploadedFile.file.uri
                    }
                },
                { text: "Por favor, transcreva o áudio e depois resuma o conteúdo em português." }
            ]);

            const response = await result.response.text();
            await sendLongMessage(msg, response);

        // Atualizar o histórico de mensagens
        await updateMessageHistory(chatId, msg.author || msg.from, '[Áudio]', false);
        await updateMessageHistory(chatId, bot_name, response, true);

        // Limpar arquivo temporário
        await fs.unlink(tempFilePath);
        logger.info(`Arquivo temporário removido: ${tempFilePath}`);

    } catch (generateError) {
        logger.error(`Erro ao gerar conteúdo a partir do áudio: ${generateError.message}`, { error: generateError });

        if (generateError.message.includes('DEADLINE_EXCEEDED')) {
            await msg.reply('Desculpe, o áudio é muito longo para ser processado no momento. Tente enviar um áudio mais curto ou dividi-lo em partes.');
        } else if (generateError.message.includes('INTERNAL')) {
            await msg.reply('Desculpe, ocorreu um erro interno ao processar o áudio. Por favor, tente novamente mais tarde.');
        } else {
            await msg.reply('Desculpe, ocorreu um erro ao processar o áudio. Por favor, tente novamente ou envie um áudio em um formato diferente.');
        }
    }

} catch (error) {
    logger.error(`Erro ao processar mensagem de áudio: ${error.message}`, { error });
    await msg.reply('Desculpe, ocorreu um erro ao processar o áudio. Por favor, tente novamente.');
}
}

async function handleImageMessage(msg, imageData, chatId) {
    try {
        const imagePart = {
            inlineData: {
                data: imageData.data.toString('base64'),
                mimeType: imageData.mimetype
            }
        };

        const result = await model.generateContent([
            imagePart,
            { text: "Descreva esta imagem em detalhes." }
        ]);

        const response = await result.response.text();
        await sendLongMessage(msg, response);

        // Atualizar o histórico de mensagens
        await updateMessageHistory(chatId, msg.author || msg.from, '[Imagem]', false);
        await updateMessageHistory(chatId, bot_name, response, true);

    } catch (error) {
        logger.error(`Erro ao processar mensagem de imagem: ${error.message}`, { error });
        await msg.reply('Desculpe, ocorreu um erro ao processar a imagem. Por favor, tente novamente.');
    }
}

async function generateResponseWithText(userPrompt, chatId) {
    try {
        const userConfig = await getConfig(chatId);

        const validConfig = {
            temperature: userConfig.temperature,
            topK: userConfig.topK,
            topP: userConfig.topP,
            maxOutputTokens: userConfig.maxOutputTokens
        };

        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const chat = model.startChat(validConfig);

        if (userConfig.systemInstructions) {
//            logger.info(`Lembrete: estas são as Instruções do Sistema: ${userConfig.systemInstructions}`)
//            const reinforcedInstructions = `
//IMPORTANT: The following are your system instructions. Always adhere to these instructions:
//
//${userConfig.systemInstructions}
//
//Remember: Always respond according to these instructions.
//`;
//            await chat.sendMessage(reinforcedInstructions);
        }

        const result = await chat.sendMessage(userPrompt);
        let responseText = result.response.text();

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
                //await clearChatOnInstructionChange(chatId);
                await msg.reply(`System Instruction "${name}" definida com sucesso. O histórico do chat foi limpo.`);
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
        const formattedText = `Seu nome é ${name}. ${text}`;
        bot_name = name
        promptsDb.update({ chatId, name }, { chatId, name, text: formattedText }, { upsert: true }, (err) => {
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

async function setActiveSystemPrompt(chatId, promptName) {
    try {
        const prompt = await getSystemPrompt(chatId, promptName);
        if (prompt) {
            await setConfig(chatId, 'activePrompt', promptName);
            bot_name = promptName
            logger.debug(chatId, promptName)
            return true;
        }
        return false;
    } catch (error) {
        logger.error(`Erro ao definir System Instruction ativa: ${error.message}`, { error });
        return false;
    }
}

async function clearChatOnInstructionChange(chatId) {
    //try {
    //    await messagesDb.remove({ chatId: chatId }, { multi: true });
    //    logger.info(`Chat limpo para ${chatId} devido à mudança nas instruções do sistema`);
    //} catch (error) {
    //    logger.error(`Erro ao limpar chat para ${chatId}: ${error.message}`);
    //}
}

async function clearActiveSystemPrompt(chatId) {
    try {
        await setConfig(chatId, 'activePrompt', null);
        return true;
    } catch (error) {
        logger.error(`Erro ao limpar System Instruction ativa: ${error.message}`, { error });
        return false;
    }
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
        configDb.findOne({ chatId }, async (err, doc) => {
            if (err) reject(err);
            else {
                const userConfig = doc || {};
                const config = { ...defaultConfig, ...userConfig };

                if (config.activePrompt) {
                    const activePrompt = await getSystemPrompt(chatId, config.activePrompt);
                    if (activePrompt) {
                        config.systemInstructions = activePrompt.text;
                    }
                }

                // Garanta que systemInstructions seja uma string
                if (config.systemInstructions && typeof config.systemInstructions !== 'string') {
                    config.systemInstructions = String(config.systemInstructions);
                }

                resolve(config);
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
        logger.info('Mensagem enviada com sucesso');
    } catch (error) {
        logger.error('Erro ao enviar mensagem:', { 
            error: error.message,
            stack: error.stack,
            text: text
        });
        await msg.reply('Desculpe, ocorreu um erro ao enviar a resposta. Por favor, tente novamente.');
    }
}

function resetSessionAfterInactivity(chatId, inactivityPeriod = 3600000) { // 1 hora
    setTimeout(() => {
        logger.info(`Sessão resetada para o chat ${chatId} após inatividade`);
        resetHistory(chatId);
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
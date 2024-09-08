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

// Configuração do logger
const logger = winston.createLogger({
    level: 'debug',
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

// Mapa para armazenar modelos com System Instructions
const userModels = new Map();

// Mapa para armazenar as últimas respostas por usuário
const lastResponses = new Map();

// Configuração padrão
const defaultConfig = {
    temperature: 1.5,
    topK: 100,
    topP: 0.95,
    maxOutputTokens: 1024,
};

// Função para criar um novo modelo com System Instruction
function createModelWithSystemInstruction(systemInstruction) {
    return genAI.getGenerativeModel({
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
                threshold: "BLOCK_NONE,
              },
              {
                category: "HARM_CATEGORY_DANGEROUS_CONTENT",
                threshold: "BLOCK_NONE",
              },
            // Adicione outras configurações de segurança conforme necessário
        ],
        systemInstruction: systemInstruction,
    });
}

// Modelo padrão sem System Instruction
let defaultModel = createModelWithSystemInstruction("");

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

// Modificar o evento message_create para incluir logs e melhorar a detecção de comandos
client.on('message_create', async (msg) => {
    try {
        if (msg.fromMe) return;

        const chat = await msg.getChat();
        await chat.sendSeen();

        console.log('Mensagem recebida:', msg.body); // Log para debug

        if (chat.isGroup) {
            const shouldRespond = await shouldRespondInGroup(msg, chat);
            if (!shouldRespond) return;
        }

        if (msg.body.startsWith('!')) {
            console.log('Comando detectado:', msg.body); // Log para debug
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

        // Resetar a sessão após processar a mensagem
        resetSessionAfterInactivity(msg.from);
    } catch (error) {
        console.error('Erro ao processar mensagem:', error);
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

// Modificar a função handleCommand para incluir mais logs e tratamento de erros
async function handleCommand(msg) {
    const [command, ...args] = msg.body.slice(1).split(' ');
    console.log('Comando:', command, 'Argumentos:', args); // Log para debug

    try {
        switch (command.toLowerCase()) {
            case 'reset':
                await resetHistory(msg.from);
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
                await handlePromptCommand(msg, args);
                break;
            case 'config':
                await handleConfigCommand(msg, args);
                break;
            case 'test':
                await testCommand(msg);
                break;
            default:
                await msg.reply('Comando desconhecido. Use !help para ver os comandos disponíveis.');
        }
    } catch (error) {
        console.error('Erro ao executar comando:', error);
        logger.error('Erro ao executar comando:', error);
        await msg.reply('Desculpe, ocorreu um erro ao executar o comando. Por favor, tente novamente.');
    }
}

async function testCommand(msg) {
    try {
        await msg.reply('Comando de teste executado com sucesso!');
    } catch (error) {
        console.error('Erro no comando de teste:', error);
        await msg.reply('Erro ao executar o comando de teste.');
    }
}

async function handlePromptCommand(msg, args) {
    const [subcommand, name, ...rest] = args;
    const userId = msg.from;

    switch (subcommand) {
        case 'set':
            if (name && rest.length > 0) {
                const promptText = rest.join(' ');
                await setSystemPrompt(userId, name, promptText);
                await msg.reply(`System Instruction "${name}" definida com sucesso.`);
            } else {
                await msg.reply('Uso correto: !prompt set <nome> <texto>');
            }
            break;
        case 'get':
            if (name) {
                const prompt = await getSystemPrompt(userId, name);
                if (prompt) {
                    await msg.reply(`System Instruction "<span class="math-inline">\{name\}"\:\\n</span>{prompt.text}`);
                } else {
                    await msg.reply(`System Instruction "${name}" não encontrada.`);
                }
            } else {
                await msg.reply('Uso correto: !prompt get <nome>');
            }
            break;
        case 'list':
            const prompts = await listSystemPrompts(userId);
            if (prompts.length > 0) {
                const promptList = prompts.map(p => p.name).join(', ');
                await msg.reply(`System Instructions disponíveis: ${promptList}`);
            } else {
                await msg.reply('Nenhuma System Instruction definida.');
            }
            break;
        case 'use':
            if (name) {
                const prompt = await getSystemPrompt(userId, name);
                if (prompt) {
                    await setActiveSystemPrompt(userId, name);
                    await msg.reply(`System Instruction "${name}" ativada para este chat.`);
                } else {
                    await msg.reply(`System Instruction "${name}" não encontrada.`);
                }
            } else {
                await msg.reply('Uso correto: !prompt use <nome>');
            }
            break;
        case 'clear':
            await clearActiveSystemPrompt(userId);
            await msg.reply('System Instruction removida. Usando o modelo padrão.');
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

        // Adicionar a nova mensagem ao histórico
        await updateMessageHistory(userId, msg.body, '');

        // Manter o histórico de mensagens
        const history = await getMessageHistory(userId);

        // Identificar a última pergunta no histórico ANTES de adicionar a nova mensagem
        const lastQuestion = getLastQuestion(history);

        const model = getModelForUser(userId);

        // Construir o prompt com o contexto e a última pergunta
        const userPromptText = history.join('\n\n') + '\n\n' + lastQuestion;

        console.log('Gerando resposta para:', userPromptText);
        console.log('Pergunta recebida: ', lastQuestion)
        const response = await generateResponseWithText(model, userPromptText, userId);
        console.log('Resposta gerada:', response);

        // Verificar se a resposta é similar à última resposta gerada
        const lastResponse = lastResponses.get(userId);
        if (lastResponse && isSimilar(response, lastResponse)) {
            // Se a resposta for similar, gere uma nova resposta ou forneça uma mensagem alternativa
            response = "Desculpe, parece que já respondi a essa pergunta. Tente perguntar algo diferente.";
        }

        // Atualizar a última resposta gerada
        lastResponses.set(userId, response);

        if (!response || response.trim() === '') {
            response = "Desculpe, ocorreu um erro ao gerar a resposta. Por favor, tente novamente.";
        }

        await updateMessageHistory(userId, msg.body, response);
        await sendLongMessage(msg, response);
    } catch (error) {
        console.error('Erro detalhado em handleTextMessage:', error);
        logger.error('Erro ao processar mensagem de texto:', error);
        await msg.reply('Desculpe, ocorreu um erro ao processar sua mensagem. Por favor, tente novamente.');
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

async function generateResponseWithText(model, userPrompt, userId) {
    try {
        const userConfig = await getConfig(userId);

        const validConfigKeys = ['temperature', 'topK', 'topP', 'maxOutputTokens'];
        const filteredConfig = Object.fromEntries(
            Object.entries(userConfig).filter(([key]) => validConfigKeys.includes(key))
        );

        console.log('Configuração filtrada:', filteredConfig);

        const result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: userPrompt }] }],
            generationConfig: filteredConfig,
        });

        const responseText = result.response.text();
        console.log('Resposta gerada:', responseText);

        if (!responseText) {
            throw new Error('Resposta vazia gerada pelo modelo');
        }

        return responseText;
    } catch (error) {
        console.error('Erro detalhado em generateResponseWithText:', error);
        logger.error('Erro ao gerar resposta de texto:', error);

        if (error.message.includes('SAFETY')) {
            return "Desculpe, não posso gerar uma resposta para essa solicitação devido a restrições de segurança. Por favor, tente reformular sua pergunta de uma maneira diferente.";
        }

        return "Desculpe, ocorreu um erro ao gerar a resposta. Por favor, tente novamente ou reformule sua pergunta.";
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

function setSystemPrompt(userId, name, text) {
    return new Promise((resolve, reject) => {
        promptsDb.update({ userId, name }, { userId, name, text }, { upsert: true }, (err) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

function getSystemPrompt(userId, name) {
    return new Promise((resolve, reject) => {
        promptsDb.findOne({ userId, name }, (err, doc) => {
            if (err) reject(err);
            else resolve(doc);
        });
    });
}

function listSystemPrompts(userId) {
    return new Promise((resolve, reject) => {
        promptsDb.find({ userId }, (err, docs) => {
            if (err) reject(err);
            else resolve(docs);
        });
    });
}

function setActiveSystemPrompt(userId, promptName) {
    return new Promise((resolve, reject) => {
        getSystemPrompt(userId, promptName).then(prompt => {
            if (prompt) {
                const model = createModelWithSystemInstruction(prompt.text);
                userModels.set(userId, model);
                messagesDb.update(
                    { userId, type: 'activePrompt' },
                    { userId, type: 'activePrompt', promptName },
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

function clearActiveSystemPrompt(userId) {
    return new Promise((resolve, reject) => {
        userModels.delete(userId);
        messagesDb.remove({ userId, type: 'activePrompt' }, {}, (err) => {
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
                getSystemPrompt(userId, doc.promptName).then(resolve).catch(reject);
            } else {
                resolve(null);
            }
        });
    });
}

function getModelForUser(userId) {
    return userModels.get(userId) || defaultModel;
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
            console.log('Tentativa de enviar mensagem inválida:', text);
            text = "Desculpe, ocorreu um erro ao gerar a resposta. Por favor, tente novamente.";
        }

        let trimmedText = text.trim();
        trimmedText = trimmedText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n{3,}/g, '\n\n');

        console.log('Enviando mensagem:', trimmedText);
        await msg.reply(trimmedText);
    } catch (error) {
        console.error('Erro ao enviar mensagem:', error);
        logger.error('Erro ao enviar mensagem:', error);
        await msg.reply('Desculpe, ocorreu um erro ao enviar a resposta. Por favor, tente novamente.');
    }
}

function resetSessionAfterInactivity(userId, inactivityPeriod = 3600000) { // 1 hora
    setTimeout(() => {
        // Aqui você pode adicionar qualquer lógica de reset que seja necessária
        // Por exemplo, limpar o histórico de mensagens ou redefinir configurações específicas do usuário
        console.log(`Sessão resetada para o usuário ${userId} após inatividade`);
    }, inactivityPeriod);
}

function getLastQuestion(history) {
    return history[history.length - 1]; // Retorna a última mensagem do usuário
}

function isSimilar(text1, text2) {
    // Implemente sua lógica de comparação de similaridade aqui
    // Você pode usar algoritmos como Levenshtein distance, cosine similarity, etc.
}

client.initialize();

process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception:', error);
    process.exit(1);
});
# Bot de WhatsApp com IA Gemini do Google

Este projeto implementa um bot de WhatsApp alimentado pela IA Gemini do Google, capaz de processar entradas de texto, áudio e imagem. Ele oferece uma série de recursos, incluindo instruções de sistema personalizáveis, gerenciamento de configurações e rastreamento de usuários.

## Índice

- [Bot de WhatsApp com IA Gemini do Google](#bot-de-whatsapp-com-ia-gemini-do-google)
  - [Índice](#índice)
  - [Funcionalidades](#funcionalidades)
  - [Pré-requisitos](#pré-requisitos)
  - [Instalação](#instalação)
  - [Configuração](#configuração)
  - [Uso](#uso)
  - [Informações sobre a LLM](#informações-sobre-a-llm)
  - [Construindo Prompts Eficazes](#construindo-prompts-eficazes)

## Funcionalidades

- Processamento de mensagens de texto, áudio e imagem
- Instruções de sistema personalizáveis (prompts)
- Gerenciamento de configurações
- Rastreamento de usuários em chats em grupo
- Sistema de registro (logging)
- Gerenciamento de histórico de mensagens
- Redefinição de sessão baseada em inatividade

## Pré-requisitos

- Node.js (v12 ou superior recomendado)
- npm (Gerenciador de Pacotes do Node)
- Uma conta do Google Cloud com a API Generative AI ativada
- Conta do WhatsApp

## Instalação

1. Clone o repositório:

   ```bash
   git clone https://github.com/manelsen/gemini-whatsapp-bot.git
   cd gemini-whatsapp-bot
   ```

2. Instale as dependências:

   ```bash
   npm install
   ```

3. Configure as variáveis de ambiente:
   Crie um arquivo `.env` no diretório raiz e adicione o seguinte:

   ```bash
   API_KEY=sua_chave_api_do_google_generative_ai
   BOT_NAME=NomeDoSeuBot
   MAX_HISTORY=500
   ```

4. Execute o bot:

   ```bash
   node amelie.js
   ```

5. Escaneie o código QR com o WhatsApp para fazer login.

## Configuração

Você pode configurar o bot usando os seguintes comandos:

- `!config set <param> <valor>`: Define um parâmetro de configuração
- `!config get [param]`: Obtém a configuração atual

Parâmetros disponíveis:

- `temperature`
- `topK`
- `topP`
- `maxOutputTokens`

## Uso

O bot responde a mensagens de texto, mensagens de áudio e imagens. Ele também suporta os seguintes comandos:

- `!reset`: Limpa o histórico do chat
- `!prompt set <nome> <texto>`: Define uma nova instrução de sistema
- `!prompt get <nome>`: Visualiza uma instrução de sistema existente
- `!prompt list`: Lista todas as instruções de sistema
- `!prompt use <nome>`: Usa uma instrução de sistema específica
- `!prompt clear`: Remove a instrução de sistema ativa
- `!users`: Lista os usuários em um chat em grupo
- `!help`: Mostra os comandos disponíveis

## Informações sobre a LLM

Este bot usa o modelo Gemini 1.5 Flash do Google, que faz parte da API Generative AI. Principais características incluem:

- Capacidades multimodais (texto, áudio, imagem)
- Alto desempenho e baixa latência
- Parâmetros de geração personalizáveis (temperatura, topK, topP, etc.)
- Configurações de segurança para filtrar conteúdo prejudicial

## Construindo Prompts Eficazes

Ao criar instruções de sistema (prompts), considere as seguintes dicas:

1. Seja específico: Defina claramente o papel e o comportamento do bot.
2. Forneça contexto: Dê informações de fundo relevantes para o propósito do bot.
3. Use exemplos: Demonstre respostas desejadas para maior clareza.
4. Considere limitações: Esteja ciente do que o modelo pode e não pode fazer.
5. Itere e refine: Teste seus prompts e ajuste com base no desempenho do bot.

Exemplo de prompt:

```text
Seu nome é Amélie. Você é uma assistente prestativa especializada em tecnologia e programação. Quando perguntada sobre código, sempre forneça explicações e exemplos. Se não tiver certeza sobre algo, admita e ofereça-se para pesquisar mais. Mantenha um tom amigável e profissional em todas as interações.
```

Lembre-se de ajustar seus prompts com base nas necessidades específicas do seu caso de uso e no desempenho do bot.

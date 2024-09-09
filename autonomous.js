const { GoogleAIFileManager } = require("@google/generative-ai/server")
const { GoogleGenerativeAI } = require("@google/generative-ai");

console.log("Inicializando File Manager")
const fileManager = new GoogleAIFileManager("AIzaSyB6koNManOGMR4_emo3YInAtl5GJqCIbNA");
console.log("Upload do arquivo")
const audioFile = fileManager.uploadFile("audio.mp3", {mimeType: "audio/mp3",});
console.log("Upload terminado")

// Initialize GoogleGenerativeAI with your API_KEY.
const genAI = new GoogleGenerativeAI("AIzaSyB6koNManOGMR4_emo3YInAtl5GJqCIbNA");

// Initialize a Gemini model appropriate for your use case.
const model = genAI.getGenerativeModel({model: "gemini-1.5-flash",});

// Generate content using a prompt and the metadata of the uploaded file.
//const result = model.generateContent([{fileData: {mimeType: "audio/mp3", fileUri: audioFile.file.uri }},{text: "Describe the audio so that a Deaf person can understand and enjoy it." },]);

// Print the response.
//console.log(result.response.text())
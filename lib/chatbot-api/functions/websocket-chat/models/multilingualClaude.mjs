import ClaudeModel from './claude3Sonnet.mjs'
import {
  TranslateClient,
  TranslateTextCommand,
} from '@aws-sdk/client-translate';
import {
  ComprehendClient,
  DetectDominantLanguageCommand,
} from '@aws-sdk/client-comprehend';
import { skip } from 'node:test';

export default class MultilingualClaudeModel extends ClaudeModel {
    constructor(){
        super();
        this.translateClient = new TranslateClient({ region: "us-east-1" });
        this.comprehendClient = new ComprehendClient({ region: "us-east-1" });
        this.localizedLanguages = ["en", "es", "pt", "fr", "de", "ja", "it"];
    }

    async detectLanguage(text){
        try{
            const params = {
                "Text": text
            };
            const command = new DetectDominantLanguageCommand(params);
            const response = await this.comprehendClient.send(command);
            const detectedLangs = response.Languages;
            if(detectedLangs.length > 0){
                for (let lang of detectedLangs){
                    console.log("detect lang: ", lang.LanguageCode, " with score: ", lang.Score);
                }
                return detectedLangs[0].LanguageCode;
            } else{
                throw new Error("Could not detect language");
            }
        } catch (err){
            console.error(err); 
        }
    }

    async translateText(text, sourceLang, targetLang){
        try{
            if (sourceLang === targetLang){
                return text;
            }
            const params = {
                SourceLanguageCode: sourceLang,
                TargetLanguageCode: targetLang,
                Text: text
            };
            const command = new TranslateTextCommand(params);
            const response = await this.translateClient.send(command);
            return response.TranslatedText;
        } catch (err){
            console.error(err);
        }
    }

    /** Helper function to ensure chat history is in the given localized language*/
    async cleanHistory(history, targetLanguageCode) {
        try{
            let translatedChatHistory = [];
            for (let chatEntry of history) {
                if (chatEntry.content.type !== "text"){
                    translatedChatHistory.push(chatEntry);
                } else{
                    let entryLangCode = await this.detectLanguage(chatEntry.content[0].text);
                    let translatedEntry = await this.translateText(chatEntry.content[0].text, entryLangCode, targetLanguageCode);
                    translatedChatHistory.push({"role": chatEntry.role, "content": [{"type": "text", "text": translatedEntry}]});
                }
            }
            return translatedChatHistory;
        } catch (err){
            console.error("error translating chat history: ", err);
        }   
    }

    async *streamTranslatedChunks(system, history) {
        try{ 
            const userQuery = history[0].content[0].text.replace("Please use your search tool one or more times based on this latest prompt:", "");
            const userLangCode = await this.detectLanguage(userQuery);
            console.log("user lang code: ", userLangCode);
            const needsTranslation = !this.localizedLanguages.includes(userLangCode);
            console.log("needs translation: ", needsTranslation);
            const targetLangCode = needsTranslation ? "en" : userLangCode;
            const cleanedHistory = await this.cleanHistory(history, targetLangCode);
            // console.log("cleaned history: ", cleanedHistory);
            // cleanedHistory[cleanedHistory.length - 1].chatbot = "Please use your search tool one or more times based on this latest prompt: ".concat(cleanedHistory[cleanedHistory.length - 1].chatbot); 
            // console.log("cleaned history with prompt: ", cleanedHistory);
            if (!needsTranslation && targetLangCode !== "en"){
                // add to the most recent message to please respond in the user's lang code
                cleanedHistory[cleanedHistory.length - 1].chatbot += `Please respond in (${targetLangCode})`;
            }
            const stream = await super.getStreamedResponse(system, cleanedHistory);
            let englishChunkBuffer = '';
            for await (const event of stream) {
                const chunkJson = new TextDecoder().decode(event.chunk.bytes);
                const chunk = JSON.parse(chunkJson);
                if (!needsTranslation) {
                    yield event;
                } else {
                    // Handle 'content_block_delta' with 'text_delta'
                    if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
                        const textDelta = chunk.delta.text;
                        englishChunkBuffer += textDelta;
                        // Process buffer when newline is encountered
                        while (englishChunkBuffer.includes('\n')) {
                            const newlineIndex = englishChunkBuffer.indexOf('\n');
                            const toTranslate = englishChunkBuffer.slice(0, newlineIndex + 1); // Include newline
                            englishChunkBuffer = englishChunkBuffer.slice(newlineIndex + 1);
                            let translatedText = toTranslate;
                            if (needsTranslation) {
                                translatedText = await this.translateText(toTranslate, 'en', userLangCode);
                            }
                            // Repackage the translated text into the chunk structure
                            const translatedChunk = {
                                type: 'content_block_delta',
                                delta: {
                                    type: 'text_delta',
                                    text: translatedText,
                                },
                            };
                            const newEvent = {
                                chunk: {
                                    bytes: new TextEncoder().encode(JSON.stringify(translatedChunk)),
                                },
                            };
                            yield newEvent;
                        }
                    } else {
                    // Yield other chunk types as-is
                    yield event;
                    }
                }
            }
            if (needsTranslation) {
                // Handle any remaining text in the buffer
                if (englishChunkBuffer.length > 0) {
                    let translatedText = englishChunkBuffer;
                    if (needsTranslation) {
                        translatedText = await this.translateText(englishChunkBuffer, 'en', userLangCode);
                    }
                    const translatedChunk = {
                        type: 'content_block_delta',
                        delta: {
                            type: 'text_delta',
                            text: translatedText,
                        },
                    };
                    const newEvent = {
                        chunk: {
                            bytes: new TextEncoder().encode(JSON.stringify(translatedChunk)),
                        },
                    };
                    yield newEvent;
                }
            }
        } catch (err){
            console.error(err);
        }
    }

    async getNoContextResponse(prompt, len,){
        try {
            const givenLangCode = await this.detectLanguage(prompt);
            const needsTranslation = !this.localizedLanguages.includes(givenLangCode);
            const targetLangCode = needsTranslation ? "en" : givenLangCode;
            const translatedPrompt = await this.translateText(prompt, givenLangCode, targetLangCode);
            // invoke parent class getNoContextResponse
            const response = await super.getNoContextResponse(translatedPrompt, len);
            if (needsTranslation){
                return await this.translateText(response, targetLangCode, givenLangCode);
            } else {
                return response;
            }
        } catch (err){
            console.error(err);
        }
    }

    async *streamNoContextResponse(prompt, targetLangCode) {
        const needsTranslation = !this.localizedLanguages.includes(targetLangCode);
        const stream = await super.getNoContextStreamedResponse(prompt);
        let englishChunkBuffer = '';
        for await (const event of stream) {
            const chunkJson = new TextDecoder().decode(event.chunk.bytes);
            const chunk = JSON.parse(chunkJson);
            if (!needsTranslation) {
                yield event;
            } else {
                // Handle 'content_block_delta' with 'text_delta'
                if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
                    const textDelta = chunk.delta.text;
                    englishChunkBuffer += textDelta;
                    // Process buffer when newline is encountered
                    while (englishChunkBuffer.includes('\n')) {
                        const newlineIndex = englishChunkBuffer.indexOf('\n');
                        const toTranslate = englishChunkBuffer.slice(0, newlineIndex + 1); // Include newline
                        englishChunkBuffer = englishChunkBuffer.slice(newlineIndex + 1);
                        let translatedText = toTranslate;
                        if (needsTranslation) {
                            translatedText = await this.translateText(toTranslate, 'en', targetLangCode);
                        }
                        // Repackage the translated text into the chunk structure
                        const translatedChunk = {
                            type: 'content_block_delta',
                            delta: {
                                type: 'text_delta',
                                text: translatedText,
                            },
                        };
                        const newEvent = {
                            chunk: {
                                bytes: new TextEncoder().encode(JSON.stringify(translatedChunk)),
                            },
                        };
                        yield newEvent;
                    }
                } else {
                // Yield other chunk types as-is
                yield event;
                }
            }
        }
        if (needsTranslation) {
            // Handle any remaining text in the buffer
            if (englishChunkBuffer.length > 0) {
                let translatedText = englishChunkBuffer;
                if (needsTranslation) {
                    translatedText = await this.translateText(englishChunkBuffer, 'en', targetLangCode);
                }
                const translatedChunk = {
                    type: 'content_block_delta',
                    delta: {
                        type: 'text_delta',
                        text: translatedText,
                    },
                };
                const newEvent = {
                    chunk: {
                        bytes: new TextEncoder().encode(JSON.stringify(translatedChunk)),
                    },
                };
                yield newEvent;
            }
        }
    }

}
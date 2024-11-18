import { ApiGatewayManagementApiClient, PostToConnectionCommand, DeleteConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import { BedrockAgentRuntimeClient, RetrieveCommand as KBRetrieveCommand } from "@aws-sdk/client-bedrock-agent-runtime";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda"
import ClaudeModel from "./models/claude3Sonnet.mjs";
import MultilingualClaudeModel from './models/multilingualClaude.mjs';
import Mistral7BModel from "./models/mistral7b.mjs"
// import neccesary dynamoDB and S3 client libraries
import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
// import { send } from 'process';

/*global fetch*/

const ENDPOINT = process.env.WEBSOCKET_API_ENDPOINT;
const SYS_PROMPT = process.env.PROMPT;
const CONFL_PROMPT = process.env.CONFL_PROMPT;
const wsConnectionClient = new ApiGatewayManagementApiClient({ endpoint: ENDPOINT });

/* Use the Bedrock Knowledge Base*/
async function retrieveKBDocs(query, knowledgeBase, knowledgeBaseID) {
  const input = { // RetrieveRequest
  knowledgeBaseId: knowledgeBaseID, // required
  retrievalQuery: { // KnowledgeBaseQuery
    text: query, // required
  }}


  try {
    const command = new KBRetrieveCommand(input);
    const response = await knowledgeBase.send(command);

    // filter the items based on confidence, we do not want LOW confidence results
    const confidenceFilteredResults = response.retrievalResults.filter(item =>
      item.score > 0.5
    )
    // Prepare documents array
    const documents = confidenceFilteredResults.map((item) => {
        return {
          content: item.content.text,
          uri: item.location.s3Location.uri,
          title:
            item.location.s3Location.uri.slice(
              item.location.s3Location.uri.lastIndexOf('/') + 1
            ) + ' (Bedrock Knowledge Base)',
        };
      });

    // Remove duplicate sources based on URI
    const flags = new Set();
    const uniqueDocuments = documents.filter((entry) => {
      if (flags.has(entry.uri)) {
        return false;
      }
      flags.add(entry.uri);
      return true;
    });

    // case for if no context was relevant
    if (uniqueDocuments.length === 0) {
        console.log('Warning: no relevant sources found');
        uniqueDocuments.push({
          content: `No knowledge available! This query is likely outside the scope of your knowledge.
          Please provide a general answer but do not attempt to provide specific details.`,
          uri: '',
          title: '',
        });
      } 

    return {
      documents: uniqueDocuments,
    };
  } catch (error) {
    console.error("Caught error: could not retreive Knowledge Base documents:", error);
    // return no context
    return {
        documents: [
          {
            content: `No knowledge available! There is something wrong with the search tool. Please tell the user to submit feedback.
          Please provide a general answer but do not attempt to provide specific details.`,
            uri: '',
            title: '',
          },
        ],
      };
  }
}

// helper function to send data via websocket connection
const sendData = async (connectionId, data) => {
    try{
        let responseParams = {
            ConnectionId: connectionId,
            Data: data,
          };
          let command = new PostToConnectionCommand(responseParams);
          await wsConnectionClient.send(command); 
    } catch (error) {
        console.error("Error sending data via websocket:", error);
    }
};


const generateConflictReport = async (connectionId, requestJSON) => {
    try {
      const data = requestJSON.data;
  
      const userId = data.user_id;
      const sessionId = data.session_id;
      const messageIndex = data.key; // Index of the message for which conflict report is requested
  
      // Retrieve session info with session handler get operation
      const sessionRequest = {
        body: JSON.stringify({
            "operation": "get_session",
            "user_id": userId,
            "session_id": sessionId
        })
      };
      // invoke the session handler lambda
      const client = new LambdaClient({});
      const lambdaCommand = new InvokeCommand({
        FunctionName: process.env.SESSION_HANDLER,
        Payload: JSON.stringify(sessionRequest),
      });
      // get chathistory from session data
      const { Payload } = await client.send(lambdaCommand);
        const result = Buffer.from(Payload).toString();
        // Check if the request was successful
        if (!result) {
            throw new Error("Error retriving session data!");
        }
        // Parse the JSON
        let output = {};
        try {
            const response = JSON.parse(result);
            output = JSON.parse(response.body);
            console.log('Parsed JSON:', output);
        } catch (error) {
            await sendData(connectionId, "<!ERROR!>: Unable to load past messages, please retry your query");
            console.error('Failed to parse JSON:', error);
            return; // Optional: Stop further execution in case of JSON parsing errors
        }
        console.log('Output:', output);
        let userChatHistory = output.chat_history;
      console.log("message index", messageIndex);
      console.log("chat history", userChatHistory[messageIndex]);
  
      const chatEntry = userChatHistory[messageIndex];
      if (!chatEntry) {
        throw new Error('Chat entry not found.');
      }
      console.log('Chat Entry:', chatEntry);
  
      const userMessage = chatEntry.user;
      const sources = JSON.parse(chatEntry.metadata);
      console.log('Conflict Sources:', sources);
  
      // Retrieve documents with the knowledge base and match on uri
      const knowledgeBase = new BedrockAgentRuntimeClient({ region: 'us-east-1' });
      if (!process.env.KB_ID) {
        throw new Error("Knowledge Base ID is not found.");
      }
      let docResult = await retrieveKBDocs(
        userMessage,
        knowledgeBase,
        process.env.KB_ID
      );
      const sourceUris = sources.map((source) => source.uri);
      const documents = docResult.documents.filter((doc) => sourceUris.includes(doc.uri) && doc.uri !== '');
      let conflictReport = "";
      console.log("conflict docs: ", documents);

      if (documents.length === 0) {
        console.log('No matching documents found for conflict report.');
        conflictReport = `No matching documents found for conflict report.`;
        await sendData(connectionId, conflictReport);
        await sendData(connectionId, '!<|EOF_STREAM|>!');
        //return;
      }
      else{
        // Prepare the prompt for conflict detection
        let prompt = `The following are documents retrieved from a knowledge base for a user's query.\n\n`;
        documents.forEach((doc, index) => {
            prompt += `Document ${index + 1} (${doc.title}):\n${doc.content}\n\n`;
        });
        prompt += CONFL_PROMPT;
    
        // Use the model to generate the conflict report
        let conflictModel = new MultilingualClaudeModel();

        const userLangCode = await conflictModel.detectLanguage(userMessage);
        const needsTranslation = !conflictModel.localizedLanguages.includes(userLangCode);
        if (!needsTranslation && userLangCode !== 'en') {
          prompt += "\n Please respond in the language of the user's query: " + userLangCode;
          prompt += `\n User message: ${userMessage}`;
          console.log("condition 1")
        } else if (needsTranslation) {
          const translatedMessage = await conflictModel.translateText(userMessage, userLangCode, 'en');
          prompt += `\n User message: ${translatedMessage}`;
          console.log("condition 2")
        } else {
          prompt += `\n User message: ${userMessage}`;
          console.log("condition 3")
        }

        // Get the streamed response
        const stream = conflictModel.streamNoContextResponse(prompt, userLangCode);

        // Stream the response to the user via WebSocket
        try {
          console.log("Starting conflict detection stream");
            for await (const event of stream) {
              const chunk = JSON.parse(new TextDecoder().decode(event.chunk.bytes));
              //console.log("chunk: ", chunk);
              const parsedChunk = await conflictModel.parseChunk(chunk);
              //console.log("parsed chunk: ", parsedChunk);
              if (parsedChunk && typeof parsedChunk === 'string') {
                  await sendData(connectionId, parsedChunk.toString());
                  conflictReport += parsedChunk.toString();
              }
            }
    
            // Send end of stream message
            await sendData(connectionId, '!<|EOF_STREAM|>!');
        } catch (error) {
            console.error('Conflict detection stream error:', error);
            await sendData(connectionId, `<!ERROR in conflict detection!>: ${error}`);
        }
      }

      
  
      // Save the conflict report to DynamoDB with session handler update conflict report operation
      const sessionSaveRequest = {
        body: JSON.stringify({
            "operation": "update_conflict_report",
            "user_id": userId,
            "session_id": sessionId,
            "message_index": messageIndex,
            "conflict_report": conflictReport
        })
      };
      const lambdaSaveCommand = new InvokeCommand({
        FunctionName: process.env.SESSION_HANDLER,
        Payload: JSON.stringify(sessionSaveRequest),
      });
      await client.send(lambdaSaveCommand);
        
    } catch (error) {
      console.error('Error:', error);
      await sendData(connectionId, `<!ERROR!>: ${error}`);
    }
  };


const getUserResponse = async (id, requestJSON) => {
  try {
    const data = requestJSON.data;    

    let userMessage = data.userMessage;
    const userId = data.user_id;
    const sessionId = data.session_id;
    const chatHistory = data.chatHistory;    
    
    const knowledgeBase = new BedrockAgentRuntimeClient({ region: 'us-east-1' });

    if (!process.env.KB_ID) {
      throw new Error("Knowledge Base ID is not found.");
    }        

    // retrieve a model response based on the last 5 messages
    // messages come paired, so that's why the slice is only 2 (2 x 2 + the latest prompt = 5)
    //let claude = new ClaudeModel();
    let claude = new MultilingualClaudeModel();
    let lastFiveMessages = chatHistory.slice(-2);
    
    let stopLoop = false;        
    let modelResponse = ''
    
    let history = claude.assembleHistory(lastFiveMessages, "Please use your search tool one or more times based on this latest prompt: ".concat(userMessage))    
    let fullDocs = []; // Collect all documents for conflict detection 
    
    while (!stopLoop) {
      console.log("started new stream")
      const stream = claude.streamTranslatedChunks(SYS_PROMPT, history);
      try {
        // store the full model response for saving to sessions later      
        let toolInput = "";
        let assemblingInput = false
        let usingTool = false;
        let toolId;
        let skipChunk = true;
        // this is for when the assistant uses a tool
        let message = {};
        // this goes in that message
        let toolUse = {}
        
        // iterate through each chunk from the model stream
        for await (const event of stream) {
          const chunk = JSON.parse(new TextDecoder().decode(event.chunk.bytes));
          const parsedChunk = await claude.parseChunk(chunk);
          if (parsedChunk) {                      
            // this means that we got tool use input or stopped generating text
            if (parsedChunk.stop_reason) {
              if (parsedChunk.stop_reason == "tool_use") {
                assemblingInput = false;
                usingTool = true;
                skipChunk = true;
              } else {
                stopLoop = true;
                break;
              }
            }
            
            // this means that we are collecting tool use input
            if (parsedChunk.type) {
             if (parsedChunk.type == "tool_use") {
               assemblingInput = true;
               toolId = parsedChunk.id
               message['role'] = 'assistant'
               message['content'] = []
               toolUse['name'] = parsedChunk.name;
               toolUse['type'] = 'tool_use'
               toolUse['id'] = toolId;
               toolUse['input'] = {'query' : ""}
             } 
            }
            
            
            if (usingTool) {
              
              // get the full block of context from knowledge base
              let docString;
              console.log("tool input")
              console.log(toolInput);
              let query = JSON.parse(toolInput);
              
              console.log("using knowledge bases!")
              let docResult = await retrieveKBDocs(
                query.query,
                knowledgeBase,
                process.env.KB_ID
              );
              // Collect the documents
              fullDocs = fullDocs.concat(docResult.documents);              
              
              // add the model's query to the tool use message
              toolUse.input.query = query.query;
              // add the tool use message to chat history
              message.content.push(toolUse)
              history.push(message)
              
              // add the tool response to chat history
              let toolResponse = {
                  "role": "user",
                  "content": [
                      {
                          "type": "tool_result",
                          "tool_use_id": toolId,
                          "content": docResult.documents.map((doc) => doc.content).join('\n')
                      }
                  ]
              };
              
              history.push(toolResponse);
              
              usingTool = false;
              toolInput = ""
              
              console.log("correctly used tool!")
              
            } else {             
            
              if  (assemblingInput & !skipChunk) {
                toolInput = toolInput.concat(parsedChunk);
                // toolUse.input.query += parsedChunk;
              } else if (!assemblingInput) {
                // console.log('writing out to user')
                modelResponse = modelResponse.concat(parsedChunk)
                await sendData(id, parsedChunk.toString());
              } else if (skipChunk) {
                skipChunk = false;
              }
            }
            
            
            
          }
        }        
        
      } catch (error) {
        console.error("Stream processing error:", error);
        await sendData(id, `<!ERROR!>: ${error}`);
      }
  
    }

    // prepare sources
    let sourcesArray = fullDocs.map((doc) => ({ title: doc.title, uri: doc.uri }));
    let sourcesJson = JSON.stringify(sourcesArray);

    // send end of stream message and sources
    await sendData(id, '!<|EOF_STREAM|>!');
    await sendData(id, sourcesJson);
    //await sendData(id, `<!SOURCES!>: ${sourcesJson}`);
    //} catch (e) {
    //  console.error("Error sending EOF_STREAM and sources:", e);
    //}


    const sessionRequest = {
      body: JSON.stringify({
        "operation": "get_session",
        "user_id": userId,
        "session_id": sessionId
      })
    }
    const client = new LambdaClient({});
    const lambdaCommand = new InvokeCommand({
      FunctionName: process.env.SESSION_HANDLER,
      Payload: JSON.stringify(sessionRequest),
    });

    const { Payload, LogResult } = await client.send(lambdaCommand);
    const result = Buffer.from(Payload).toString();

    // Check if the request was successful
    if (!result) {
      throw new Error("Error retriving session data!");
    }

    // Parse the JSON
    let output = {};
    try {
      const response = JSON.parse(result);
      output = JSON.parse(response.body);
      console.log('Parsed JSON:', output);
    } catch (error) {
      await sendData(id, "<!ERROR!>: Unable to load past messages, please retry your query");
      console.error('Failed to parse JSON:', error);

      return; // Optional: Stop further execution in case of JSON parsing errors
    }

    // Continue processing the data
    const retrievedHistory = output.chat_history;
    let operation = '';
    let title = ''; // Ensure 'title' is initialized if used later in your code

    // Further logic goes here

    let newChatEntry = { "user": userMessage, "chatbot": modelResponse, "metadata": sourcesJson, "conflictReport": null };
    if (retrievedHistory === undefined) {
        operation = 'add_session';
        //let titleModel = new Mistral7BModel();
        const CONTEXT_COMPLETION_INSTRUCTIONS =
          `<s>[INST]Generate a concise title for this chat session based on the initial user prompt and response. The title should succinctly capture the essence of the chat's main topic without adding extra content.[/INST]
        [INST]${userMessage}[/INST]
        ${modelResponse} </s>
        Here's your session title:`;
        // title = await titleModel.getPromptedResponse(CONTEXT_COMPLETION_INSTRUCTIONS, 25);
        title = await claude.getNoContextResponse(CONTEXT_COMPLETION_INSTRUCTIONS, 25);
        title = title.replaceAll(`"`, '');
    } else {
      operation = 'update_session';
    }

    const sessionSaveRequest = {
      body: JSON.stringify({
        "operation": operation,
        "user_id": userId,
        "session_id": sessionId,
        "new_chat_entry": newChatEntry,
        "title": title
      })
    }

    const lambdaSaveCommand = new InvokeCommand({
      FunctionName: process.env.SESSION_HANDLER,
      Payload: JSON.stringify(sessionSaveRequest),
    });

    // const { SessionSavePayload, SessionSaveLogResult } = 
    await client.send(lambdaSaveCommand);

    const input = {
      ConnectionId: id,
    };
    await wsConnectionClient.send(new DeleteConnectionCommand(input));

  } catch (error) {
    console.error("Error:", error);
    await sendData(id, `<!ERROR!>: ${error}`);
  }
}

export const handler = async (event) => {
  if (event.requestContext) {    
    const connectionId = event.requestContext.connectionId;
    const routeKey = event.requestContext.routeKey;
    let body = {};
    try {
      if (event.body) {
        body = JSON.parse(event.body);
      }
    } catch (err) {
      console.error("Failed to parse JSON:", err)
    }
    console.log(routeKey);

    switch (routeKey) {
      case '$connect':
        console.log('CONNECT')
        return { statusCode: 200 };
      case '$disconnect':
        console.log('DISCONNECT')
        return { statusCode: 200 };
      case '$default':
        console.log('DEFAULT')
        return { 'action': 'Default Response Triggered' }
      case "getChatbotResponse":
        console.log('GET CHATBOT RESPONSE')
        await getUserResponse(connectionId, body)
        return { statusCode: 200 };  
      case "generateConflictReport":
        console.log('GENERATE CONFLICT REPORT')
        await generateConflictReport(connectionId, body)
        return { statusCode: 200 };    
      default:
        return {
          statusCode: 404,  // 'Not Found' status code
          body: JSON.stringify({
            error: "The requested route is not recognized."
          })
        };
    }
  }
  return {
    statusCode: 200,
  };
};  
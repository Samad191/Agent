import { QdrantClient } from "@qdrant/js-client-rest";
import "dotenv/config";
import express from "express";
import { ChatOpenAI } from "@langchain/openai";
import { v4 as uuidv4 } from "uuid";
import {
  START,
  END,
  MessagesAnnotation,
  StateGraph,
  MemorySaver,
} from "@langchain/langgraph";
import { QdrantVectorStore } from "@langchain/qdrant";
import { OpenAIEmbeddings } from "@langchain/openai";
// import { SerpAPI } from "@langchain/community/tools/serpapi";
import { SerpAPILoader } from "@langchain/community/document_loaders/web/serpapi";
import {
  SystemMessage,
  HumanMessage,
  AIMessage,
  trimMessages,
} from "@langchain/core/messages";
import { RouterChain } from "langchain/chains";
import { PromptTemplate } from "@langchain/core/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { RunnableLambda, RunnablePassthrough } from "@langchain/core/runnables";
import bodyParser from "body-parser";
import { WebClient } from "@slack/web-api";

function extractSummaryText(obj) {
  return (
    obj.description ||
    obj.snippet ||
    obj.title ||
    obj.content ||
    obj.summary ||
    "No usable text found."
  );
}

function extractImages(obj) {
  const images = [];

  // header_images might be an object or array
  if (Array.isArray(obj.header_images)) {
    images.push(...obj.header_images);
  } else if (
    typeof obj.header_images === "object" &&
    obj.header_images !== null
  ) {
    images.push(...Object.values(obj.header_images));
  }

  // Favicon (usually an image URL)
  if (
    obj.favicon &&
    typeof obj.favicon === "string" &&
    obj.favicon.startsWith("http")
  ) {
    images.push(obj.favicon);
  }

  return images;
}

const app = express();
app.use(express.json());

const client = new QdrantClient({
  url: process.env.QDRANT_URL || "http://localhost:6333",
  apiKey: process.env.QDRANT_KEY,
});

try {
  const result = await client.getCollections();
  console.log("List of collections:", result.collections);
} catch (err) {
  console.error("Could not get collections:", err);
}

const model = new ChatOpenAI({
  model: "gpt-4o-mini",
  temperature: 0,
  apiKey: process.env.OPEN_AI_KEY,
});

const embeddings = new OpenAIEmbeddings({
  model: "text-embedding-3-small",
});

const trimmer = trimMessages({
  maxTokens: 10,
  strategy: "last",
  tokenCounter: (msgs) => msgs.length,
  includeSystem: true,
  allowPartial: false,
  startOn: "human",
});

// const messages = [
//   new SystemMessage("you're a good assistant"),
//   new HumanMessage("hi! I'm bob"),
//   new AIMessage("hi!"),
//   new HumanMessage("I like vanilla ice cream"),
//   new AIMessage("nice"),
//   new HumanMessage("whats 2 + 2"),
//   new AIMessage("4"),
//   new HumanMessage("thanks"),
//   new AIMessage("no problem!"),
//   new HumanMessage("having fun?"),
//   new AIMessage("yes!"),
// ];

// await trimmer.invoke(messages);

// const serpApi = new SerpAPI(
//   {
//     apiKey: process.env.SERP_API_KEY,
//     llm: model,
//   },
//   {
//     name: "serpapi",
//     description: "Get search results from Google.",
//   }
// );

// const vectorStore = QdrantVectorStore.fromExistingCollection(embeddings, {
//   url: process.env.QDRANT_URL,
//   collectionName: "langchainjs-testing",
// });

const callModel = async (state) => {
  const response = await model.invoke(state.messages);
  return { messages: response };
};

const workflow = new StateGraph(MessagesAnnotation)
  // Define the node and edge
  .addNode("model", callModel)
  .addEdge(START, "model")
  .addEdge("model", END);

const memory = new MemorySaver();

const workflowApp = workflow.compile({ checkpointer: memory });
// const config = { configurable: { thread_id: uuidv4() } };
const config = {
  configurable: {
    thread_id: uuidv4(),
  },
};

const chatHistories = {};

app.post("/ask", async (req, res) => {
  const { question } = req.body;
  console.log("question:", question);

  const thread_id = req.body.thread_id || uuidv4();
  config.configurable.thread_id = thread_id;

  // if (!chatHistories[thread_id]) chatHistories[thread_id] = [];

  // chatHistories[thread_id].push({
  //   role: "user",
  //   content: question,
  // });

  if (!chatHistories[thread_id]) {
    chatHistories[thread_id] = [
      new SystemMessage("You are a helpful assistant"),
    ];
  }

  chatHistories[thread_id].push(new HumanMessage(question));

  console.log("here 1");

  const trimmedMessages = await trimmer.invoke(chatHistories[thread_id]);

  console.log("here 2");
  const output = await workflowApp.invoke(
    { messages: trimmedMessages },
    config
  );

  console.log("here 3");
  const reply = output.messages[output.messages.length - 1];

  console.log("reply:", reply);
  chatHistories[thread_id].push(reply);

  console.log("chatHistories:", chatHistories[thread_id]);
  ``;
  res.send(reply.content);

  // const input = [
  //   {
  //     role: "user",
  //     content: question,
  //   },
  // ];

  // const output = await workflowApp.invoke({ messages: input }, config);
  // console.log(output.messages[output.messages.length - 1].content);

  // res.send(output.messages[output.messages.length - 1].content);
});

// app.post("/serp", async (req, res) => {
//   const { question } = req.body;

//   const apiKey = process.env.SERP_API_KEY;

//   const loader = new SerpAPILoader({ q: question, apiKey });
//   const docs = await loader.load();

//   console.log("docs", typeof docs[0].pageContent);

//   console.log("first doc:",  docs);
//   const obj = JSON.parse(docs[0].pageContent);
//   const images = obj.header_images;
//   console.log("obj:", obj);

//   const summaryText = extractSummaryText(obj);

//   const input = [
//     {
//       role: "user",
//       content: `Summarize this text s "${summaryText}".`,
//     },
//   ];

//   const output = await workflowApp.invoke({ messages: input }, config);
//   const result = {
//     text: output.messages[output.messages.length - 1].content,
//     images: images,
//   };

//   res.send(result);

// });

const serpApiKey = process.env.SERP_API_KEY;

app.post("/serp", async (req, res) => {
  const { question } = req.body;

  try {
    const loader = new SerpAPILoader({ q: question, serpApiKey });
    const docs = await loader.load();

    if (!docs || docs.length === 0) {
      return res.status(404).send({ error: "No documents found." });
    }

    const summaries = [];
    const headerImages = [];
    const sources = [];

    for (let i = 0; i < Math.min(3, docs.length); i++) {
      try {
        const obj = JSON.parse(docs[i].pageContent);

        const text = extractSummaryText(obj);
        summaries.push(`${i + 1}. ${text}`);

        // Extract images
        headerImages.push(...extractImages(obj));

        // Collect source info (title + link)
        if (obj.title && obj.link) {
          sources.push({
            title: obj.title,
            link: obj.link,
            snippet: obj.snippet || null,
          });
        }
      } catch (err) {
        console.warn(`Failed to parse doc[${i}]:`, err);
      }
    }

    const prompt = `Summarize the following search results:\n\n${summaries.join(
      "\n\n"
    )}`;
    const input = [{ role: "user", content: prompt }];

    const output = await workflowApp.invoke({ messages: input }, config);

    const result = {
      text: output.messages[output.messages.length - 1].content,
      images: [...new Set(headerImages)],
      sources: sources,
    };

    res.send(result);
  } catch (error) {
    console.error("Error in /serp:", error);
    res.status(500).send({ error: "Internal server error" });
  }
});

// const llm = new ChatOpenAI({ temperature: 0 });

const classifierPrompt = PromptTemplate.fromTemplate(`
Classify the following user question.
If it needs fresh web search, answer "search".
Otherwise answer "general".
Question: {question}
Answer in one word:
`);

const classifier = classifierPrompt.pipe(model).pipe(new StringOutputParser());

app.post("/chat", async (req, res) => {
  const { question } = req.body;
  console.log("req body", req.body);

  const result = await classifier.invoke({ question });

  const route = result.trim().toLowerCase();
  if (route !== "search" && route !== "general") {
    return res.status(500).send({ error: "Unexpected classification result" });
  }

  if (route == "search") {
    const loader = new SerpAPILoader({ q: question, serpApiKey });
    const docs = await loader.load();

    if (!docs || docs.length === 0) {
      return res.status(404).send({ error: "No documents found." });
    }

    const summaries = [];
    const headerImages = [];
    const sources = [];

    for (let i = 0; i < Math.min(3, docs.length); i++) {
      try {
        const obj = JSON.parse(docs[i].pageContent);

        const text = extractSummaryText(obj);
        summaries.push(`${i + 1}. ${text}`);

        // Extract images
        headerImages.push(...extractImages(obj));

        // Collect source info (title + link)
        if (obj.title && obj.link) {
          sources.push({
            title: obj.title,
            link: obj.link,
            snippet: obj.snippet || null,
          });
        }
      } catch (err) {
        console.warn(`Failed to parse doc[${i}]:`, err);
      }

      const prompt = `Summarize the following search results:\n\n${summaries.join(
        "\n\n"
      )}`;
      const input = [{ role: "user", content: prompt }];

      const output = await workflowApp.invoke({ messages: input }, config);

      const result = {
        text: output.messages[output.messages.length - 1].content,
        images: [...new Set(headerImages)],
        sources: sources,
      };

      res.send(result);
    }
  } else if (route == "general") {
    const thread_id = req.body.thread_id || uuidv4();
    config.configurable.thread_id = thread_id;

    if (!chatHistories[thread_id]) {
      chatHistories[thread_id] = [
        new SystemMessage("You are a helpful assistant"),
      ];
    }

    chatHistories[thread_id].push(new HumanMessage(question));

    console.log("here 1");

    const trimmedMessages = await trimmer.invoke(chatHistories[thread_id]);

    console.log("here 2");
    const output = await workflowApp.invoke(
      { messages: trimmedMessages },
      config
    );

    console.log("here 3");
    const reply = output.messages[output.messages.length - 1];

    console.log("reply:", reply);
    chatHistories[thread_id].push(reply);

    console.log("chatHistories:", chatHistories[thread_id]);
    ``;
    res.send(reply.content);
  } else {
    return res.status(500).send({ error: "Unexpected classification result" });
  }
});

app.use(bodyParser.json());

const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);

const chatForSlack = async (question) => {};

app.post('/test', async (req, res) => {

  const { question } = req.body;

  const output = await workflowApp.invoke({ messages: question }, config);
    const { content } = output.messages[output.messages.length - 1];

  console.log('output', content);
  res.send(content);

} )

app.post("/slack/events", async (req, res) => {
  console.log("got slack", req.body);
  // const message = req?.body?.event?.text;

  if (req.body.type === "url_verification") {
    return res.send(req.body.challenge);
  }
  const { text } = req.body.event;
  console.log("text ", text);

  const event = req.body.event;
  console.log("event type", event.type);
    // ignore bot's own msg
  if (event.bot_id) {
    return res.sendStatus(200);
  }

  // acknowledge slack
  res.status(200).send();


  const output = await workflowApp.invoke({ messages: text }, config);
  // console.log('output', output);
      const { content } = output.messages[output.messages.length - 1];
    console.log("content", content);


  const thread_id = event.thread_ts || event.ts;

  if (event.type === "message" && !event.bot_id) {
    await slackClient.chat.postMessage({
      channel: event.channel,
      text: `${content}! 👋`,
    });
  }

  res.sendStatus(200);
});

app.get("/", (req, res) => {
  res.send("Hello world!");
});

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.clear();
  console.log("Server is running on port 4000");
});

// slack bot token
// xoxb-9336055457025-9321932608725-o01UzEh42wf1jfNCtZU0SDiw

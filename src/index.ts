import { Client } from "pg";
import {
  getCompletionFromStream,
  getTokenCount,
  getUrl,
  numTokensFromMessages,
  sha256,
} from "./lib";

export interface Env {
  HYPERDRIVE: Hyperdrive;
  DATABASE_URL: string;
}

const CACHE_AGE = 60 * 60 * 24 * 30; // 30 days

interface OpenAIResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  [key: string]: any;
}

async function generateCacheKey(url: URL, body: string, headers: Headers) {
  // Generate a unique cache key based on the URL and the request body
  const bodyHash = await sha256(body); // Use a hash function for the body
  url.pathname += `/${bodyHash}`; // Append the hash to the pathname to make the key unique

  return new Request(url.toString(), {
    headers,
    method: "GET",
  });
}

async function handleCaching(
  request: Request,
  body: string,
  headers: Headers,
  url: string,
  ctx: ExecutionContext
) {
  const cacheUrl = new URL(request.url);
  const cacheKey = await generateCacheKey(cacheUrl, body, headers); // Generate a unique cache key based on the request URL and body

  const cache = caches.default;
  let response = await cache.match(cacheKey);

  if (!response) {
    console.log("Cache miss for:", cacheKey.url);

    const newRequestHeaders = new Headers();
    newRequestHeaders.set("Content-Type", "application/json");
    newRequestHeaders.set(
      "Authorization",
      request.headers.get("Authorization")!
    );
    newRequestHeaders.set("X-Api-Key", request.headers.get("X-Api-Key")!);

    const openAIResponse = await fetch(url, {
      body: request.body,
      method: request.method,
      headers: newRequestHeaders,
    });

    response = new Response(
      openAIResponse.body as ReadableStream<Uint8Array> | null,
      {
        status: openAIResponse.status,
        statusText: openAIResponse.statusText,
        headers: openAIResponse.headers,
      }
    );
    // Set the cache-control header on the new response
    response.headers.set("cache-control", `public, max-age=${CACHE_AGE}`);

    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return { response, cached: false };
  }

  console.log("Cache hit for:", cacheKey.url);
  return { response, cached: true };
}

const parseHeaders = (headers: Headers) =>
  Object.fromEntries(headers.entries());

const parseRequest = async (request: Request) => {
  const { headers, method } = request;
  const body = method === "POST" ? JSON.parse(await request.text()) : {};
  return { headers, body, method };
};

const saveInitialRequestToDb = async ({
  client,
  url,
  method,
  headers,
  body,
  userId,
}: {
  client: Client;
  url: string;
  method: string;
  headers: Headers;
  body: Record<string, any>;
  userId: string;
}) => {
  const requestBodyJSON = JSON.stringify(body);
  const currentTimestamp = new Date().toISOString();

  try {
    // Insert into Request table
    const requestInsertQuery = `
     INSERT INTO "Request" (
       id, openai_id, ip, url, method, status,
       request_headers, request_body, response_headers, response_body,
       streamed_response_body, cached, streamed, user_id, app_id,
       prompt_tokens, completion_tokens, model, completion, "userId", "createdAt", "updatedAt"
     ) VALUES (
       gen_random_uuid(), $1, $2, $3, $4, $5,
       $6, $7, $8, $9, 
       $10, $11, $12, $13, $14,
       $15, $16, $17, $18, $19, $20, $21
     ) RETURNING id`;

    const requestInsertValues = [
      "", // openaiaid
      headers.get("x-real-ip") || "",
      url,
      method,
      200, // Set status to an default value
      JSON.stringify(parseHeaders(headers)),
      requestBodyJSON,
      {}, // Set response_headers to an default value
      {}, // Set response_body to an default value
      {}, // Set streamed_response_body to an default value
      false, // Set cached to an default value
      false, // Set streamed to an default value
      headers.get("X-User-Id") || "",
      null, // Set app_id to null
      0, // Set prompt_tokens to 0
      0, // Set completion_tokens to 0
      body.model || "", // Set model to an empty string if it exists, otherwise set it to an empty string
      "❌ An Error Occured while trying to store the AI's response", // Set completion to an empty string
      userId,
      currentTimestamp, // Set createdAt to currentTimestamp
      currentTimestamp, // Set updatedAt to currentTimestamp
    ];

    const requestResult = await client.query(
      requestInsertQuery,
      requestInsertValues
    );

    return requestResult.rows[0];
  } catch (e) {
    console.error("Error saving initial request to DB:", e);
    throw e; // It's important to handle or throw the error so you can react appropriately in the calling code
  }
};

const saveRequestToDb = async ({
  client,
  uuid,
  response,
  url,
  body,
  cached,
  streamed,
  userId,
  data,
  streamed_data,
  status,
}: {
  client: Client;
  uuid: string;
  response: Response;
  url: string;
  body: { [key: string]: any };
  cached: boolean;
  streamed: boolean;
  userId: string;
  data?: { [key: string]: any };
  streamed_data?: string;
  status?: number;
}) => {
  let streamed_id: string = "";
  let completion: string = "";
  let prompt_tokens: number = 0;
  let completion_tokens: number = 0;

  const currentTimestamp = new Date().toISOString();

  if (streamed) {
    const data = streamed_data?.split("\n\n")[0].replace("data: ", "");
    const parsed = JSON.parse(data!);
    streamed_id = parsed.id;
    console.log("Streamed id:", streamed_id);
  }

  if (url === "https://api.openai.com/v1/chat/completions") {
    if (streamed) {
      completion = getCompletionFromStream(streamed_data!);
    } else {
      completion = data?.choices[0].message.content;
    }
    prompt_tokens = await numTokensFromMessages(body.messages);
    completion_tokens = await getTokenCount(completion);
  } else if (url === "https://api.openai.com/v1/completions") {
    completion = data?.choices[0].text;
    prompt_tokens = await getTokenCount(body?.prompt);
    completion_tokens = await getTokenCount(completion);
  }

  try {
    console.log("UUID:", uuid);
    // Update the existing row in the Request table
    const requestUpdateQuery = `
     UPDATE "Request"
     SET openai_id = $1,
         response_body = $2,
         streamed_response_body = $3,
         streamed = $4,
         prompt_tokens = $5,
         completion_tokens = $6,
         completion = $7,
         "updatedAt" = $8,
         status = $9
     WHERE id = $10
     RETURNING id`;

    const openaiId = streamed ? streamed_id : data?.id || "";
    const requestUpdateValues = [
      openaiId,
      JSON.stringify(response.body),
      streamed ? streamed_data : undefined,
      streamed,
      prompt_tokens,
      completion_tokens,
      completion, // Add the completion field
      currentTimestamp, // Set updatedAt to currentTimestamp
      status,
      uuid, // Add the uuid to the query values
    ];

    const requestResult = await client.query(
      requestUpdateQuery,
      requestUpdateValues
    );

    return requestResult.rows[0];
  } catch (e) {
    console.error(e);
    return null;
  }
};

const logHeaders = async (headers: Headers) => {
  console.log(
    JSON.stringify(Object.fromEntries(headers.entries()), null, 2),
    "\n"
  );
};

const getUser = async (client: Client, apiKey: string) => {
  const hashedApiKey = await sha256(apiKey);

  const query = {
    text: 'SELECT "User".* FROM "ApiKey" JOIN "User" ON "ApiKey"."userId" = "User".id WHERE "ApiKey".hashed_key = $1',
    values: [hashedApiKey],
  };
  console.log("sending query");

  const result = await client.query(query);

  console.log("sent query");

  // Check if the user was found
  if (result.rows.length > 0) {
    return result.rows[0]; // Return the found user
  } else {
    return null; // Return null if no user was found
  }
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    console.log("");
    console.log("REQUEST RECEIVED");
    const requestCopy = request.clone();
    const { headers, body, method } = await parseRequest(request);
    const url = await getUrl(request);
    const key = headers.get("X-Api-Key")?.replace("Bearer ", "");
    let uuid = "";

    console.log("about to check for key");
    if (!key) {
      console.log("Key is missing, server error message");
      return new Response(
        JSON.stringify({
          error:
            "Missing API key in 'X-Api-Key' header. Go to https://llm.report/ to get an API key.",
          message: "",
        }),
        {
          status: 401,
        }
      );
    }

    console.log("about to connect to database");
    const client = new Client(env.DATABASE_URL);
    await client.connect();

    console.log("connected to database, about to get user");
    const user = await getUser(client, key);
    if (user && user.email) {
      console.log(user.email);
    }
    console.log("got user");
    if (!user) {
      return new Response(
        JSON.stringify({
          error: "User not found in database. Ensure your API key is correct.",
          message: "",
        }),
        {
          status: 401,
        }
      );
    }

    if (method !== "POST") {
      return new Response("Only POST request allowed", { status: 405 });
    }

    console.log("Saving initial request to db...");
    try {
      const uuidObject = await saveInitialRequestToDb({
        client,
        url,
        method,
        headers,
        body,
        userId: user.id,
      });
      uuid = uuidObject.id;
    } catch (e) {
      console.error(e);
      return new Response(
        JSON.stringify({
          error: "Error saving initial request to database. Contact support",
          message: e,
        }),
        {
          status: 500,
        }
      );
    }

    console.log("initially saved to db...");
    console.log();
    const { response, cached } = await handleCaching(
      requestCopy,
      body,
      headers,
      url,
      ctx
    );

    if (body.stream === true) {
      const c = response.clone();
      const reader = c.body!.getReader();
      const decoder = new TextDecoder();

      let responseData = "";

      reader.read().then(async function process({ done, value }): Promise<any> {
        if (done) {
          console.log();
          console.log("Stream complete. Saving to db...");
          // console.log(responseData);
          // Store responseData in your database
          ctx.waitUntil(
            saveRequestToDb({
              client,
              uuid,
              response: c,
              url,
              body,
              cached,
              streamed: true,
              userId: user.id,
              data: undefined,
              streamed_data: responseData,
              status: c.status,
            })
          );
          console.log("Request saved to db");
          return;
        }

        const text = decoder.decode(value, { stream: true });
        // console.log(text);

        responseData += text;
        return reader.read().then(process);
      });

      return response;
    } else {
      console.log("Stream is false, saving to db...");
      const c = response.clone();
      ctx.waitUntil(
        saveRequestToDb({
          client,
          uuid,
          response: c,
          url,
          body,
          cached,
          streamed: false,
          userId: user.id,
          data: await c.json(),
          status: c.status,
        })
      );
      console.log("Request saved to db");
      return response;
    }
  },
};

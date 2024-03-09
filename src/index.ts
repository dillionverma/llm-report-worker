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

    try {
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
    } catch (e) {
      console.error(e);
      return {
        response: new Response("Error fetching data from OpenAI", {
          status: 500,
        }),
        cached: false,
      };
    }
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

const saveRequestToDb = async (
  client: Client,
  request: Request,
  response: Response,
  url: string,
  body: { [key: string]: any },
  cached: boolean = false,
  streamed: boolean = false,
  userId: string,
  data?: { [key: string]: any },
  streamed_data?: string
) => {
  let streamed_id: string = "";
  let completion: string = "";
  let model: string = "";
  let prompt_tokens: number = 0;
  let completion_tokens: number = 0;

  // Convert Request and Response headers to JSON
  const requestHeaders = request.headers;
  const responseHeaders = response.headers;

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
    prompt_tokens = numTokensFromMessages(body.messages);
    completion_tokens = getTokenCount(completion);
    model = body.model;
  } else if (url === "https://api.openai.com/v1/completions") {
    completion = data?.choices[0].text;
    prompt_tokens = getTokenCount(body?.prompt);
    completion_tokens = getTokenCount(completion);
    model = body.model;
  }

  try {
    // Insert into Request table
    const requestInsertQuery = `
     INSERT INTO "Request" (
       id, openai_id, ip, url, method, status,
       request_headers, request_body, response_headers, response_body,
       streamed_response_body, cached, streamed, user_id, app_id,
       prompt_tokens, completion_tokens, model, completion, "userId",     "createdAt", "updatedAt"
     ) VALUES (
       gen_random_uuid(), $1, $2, $3, $4, $5,
       $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21
     ) RETURNING id`;

    const openaiId = streamed ? streamed_id : data?.id || "";
    const requestInsertValues = [
      openaiId,
      requestHeaders.get("x-real-ip") || "",
      url,
      request.method,
      response.status,
      JSON.stringify(requestHeaders),
      JSON.stringify(body),
      JSON.stringify(responseHeaders),
      streamed ? undefined : JSON.stringify(data),
      streamed ? streamed_data : undefined,
      cached,
      streamed,
      requestHeaders.get("X-User-Id"),
      requestHeaders.get("X-App-Id"),
      prompt_tokens,
      completion_tokens,
      model,
      completion,
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

    if (!key) {
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

    const client = new Client(env.DATABASE_URL);
    await client.connect();

    const user = await getUser(client, key);
    console.log(user.email);

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

    const { response, cached } = await handleCaching(
      requestCopy,
      body,
      headers,
      url,
      ctx
    );
    if (body.stream === true) {
      const c = response.clone();
      //@ts-ignore
      const reader = c.body.getReader();
      const decoder = new TextDecoder("utf-8");

      let responseData = "";
      let rawText = "";

      console.log("about to start parsing stream");
      let count = 0;
      reader.read().then(async function process({ done, value }): Promise<any> {
        count += 1;
        try {
          console.log(`${count}: Starting done?`, done, "value", value[0]);
        } catch (e) {
          throw new Error("Error parsing value");
        }

        if (done) {
          console.log("Stream complete, saving to db");
          try {
            ctx.waitUntil(
              saveRequestToDb(
                client,
                request,
                c,
                url,
                body,
                // metadata,
                cached,
                true,
                user.id,
                undefined,
                responseData
              )
            );
            console.log("saved to db");
            return;
          } catch (e) {
            console.log("Error saving to db");
            console.error(e);
            return;
          }
        }

        try {
          const chunk = decoder.decode(value, { stream: true });

          responseData += chunk;

          if (responseData.endsWith("\n")) {
            // Splits the responseData into chunks separated by "\n\n"

            const listChunk = responseData.replace(/data: /g, "").split("\n\n");

            listChunk.forEach((chunk) => {
              // Splits each chunk into lines
              chunk.split("\n").forEach((line) => {
                try {
                  // Assuming the line starts with a prefix that needs to be removed before parsing JSON
                  if (!line.includes("{")) {
                    return reader.read().then(process);
                  }
                  const jsonData = JSON.parse(line); // Adjust the '6' based on your actual prefix length
                  // console.log("PARSED JSON DATA:", jsonData);
                  if (
                    jsonData.choices &&
                    jsonData.choices.length > 0 &&
                    jsonData.choices[0].delta?.content
                  ) {
                    const content = jsonData.choices[0].delta.content;
                    // Append the content to rawText or handle it as needed
                    rawText += content;
                  }
                } catch (error) {
                  console.error("Error processing JSON:", error);
                }
              });
            });
          }

          if (count % 2 == 0) {
            console.log(`${count}: RAWText:`, rawText.slice(-2));
            // if (count > 825) {
            //   console.log(`${count}: RAWText:`, rawText);
            // }
            rawText = "";
          }
        } catch (e) {
          console.log(`CHUNK ${count} ERRORED:`);
          console.log("RESPONSE DATA");
          console.error(responseData);
          console.error("Error parsing JSON: ", e);
          // Optionally, handle incomplete/invalid JSON structure
          // You might want to append the chunk back to buffer or handle it differently
        }
        const result = await reader.read();
        console.log("done?", result.done);
        return process(result);
      });
      console.log();
      console.log("DONE with stream");
      return response;
    } else {
      console.log("Stream is false");
      const c = response.clone();
      try {
        ctx.waitUntil(
          saveRequestToDb(
            client,
            request,
            c,
            url,
            body,
            // metadata,
            cached,
            false,
            user.id,
            await c.json()
          )
        );
        console.log("saved to db");
        return response;
      } catch (e) {
        console.error(e);
        return response;
      }
    }
  },
};

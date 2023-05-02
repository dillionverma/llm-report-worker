import { PrismaClient } from "@prisma/client/edge";
const prisma = new PrismaClient();

addEventListener("fetch", (event) => {
  event.respondWith(handleEvent(event));
});

async function sha256(message: string) {
  // encode as UTF-8
  const msgBuffer = await new TextEncoder().encode(message);
  // hash the message
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
  // convert bytes to hex string
  return [...new Uint8Array(hashBuffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const getUrl = async (request: Request) => {
  const originalUrl = new URL(request.url);
  const openaiUrl =
    "https://api.openai.com" + originalUrl.pathname + originalUrl.search;

  return openaiUrl;
};

async function callOpenAI({
  url,
  method,
  headers,
  body,
}: {
  method: string;
  url: string;
  headers: Headers;
  body?: string;
}): Promise<Response> {
  let response: Response;

  if (method === "POST") {
    response = await fetch(url, {
      method,
      headers,
      body,
    });
    return response;
  } else if (method === "GET") {
    response = await fetch(url, {
      method,
      headers,
    });
    return response;
  } else {
    return new Response("Method not allowed", { status: 405 });
  }
}

interface OpenAIResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  [key: string]: any;
}

async function handleEvent(event: FetchEvent): Promise<Response> {
  const { request } = event;
  const headers = request.headers;
  const body = await request.text();
  const method = request.method;

  const url = await getUrl(request);

  let metadata: { [key: string]: string } = {};
  let restBody: { [key: string]: any } = {};

  if (method === "POST") {
    let { metadata: meta, ...rest } = JSON.parse(body);
    restBody = rest;
    metadata = meta;
  }

  const cacheUrl = new URL(request.url);
  const cacheKey = cacheUrl.toString();

  const cache = caches.default;
  let response = await cache.match(cacheKey);

  console.log(
    "Request Headers",
    JSON.stringify(Object.fromEntries(headers.entries()), null, 2),
    "\n"
  );
  console.log("Cache key: ", cacheKey, "\n");

  if (!response) {
    console.log(
      `Response for request url: ${request.url} not present in cache. Fetching and caching request.`
    );
    const res = await callOpenAI({
      url,
      method,
      headers,
      body: JSON.stringify(restBody),
    });

    const data: OpenAIResponse = await res.json();

    response = new Response(JSON.stringify(data), {
      headers: { "content-type": "application/json" },
    });

    if (headers.get("llm-caching-enabled") === "true") {
      console.log("Caching enabled");
      // response.headers.append("Cache-Control", "max-age=3600, public");
      await cache.put(cacheKey, response.clone());
    }
  }

  const data: OpenAIResponse = await response.json();

  // waitUntil method is used for sending logs, after response is sent
  const r = prisma.request.create({
    data: {
      id: data.id,
      url: url,
      method: request.method,
      status: response.status,
      request_headers: JSON.stringify(
        Object.fromEntries(request.headers.entries())
      ),
      request_body: JSON.stringify(request.body),
      response_headers: JSON.stringify(
        Object.fromEntries(response.headers.entries())
      ),
      response_body: JSON.stringify(data),
      metadata: {
        create: [
          ...Object.entries(metadata).map(([key, value]) => ({
            key: key,
            value: value,
          })),
        ],
      },
    },
  });

  event.waitUntil(Promise.all([r]));

  return new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json" },
  });
}

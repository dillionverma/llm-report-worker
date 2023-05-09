import { PrismaClient } from "@prisma/client/edge";
const prisma = new PrismaClient();

const CACHE_AGE = 60 * 60 * 24 * 30; // 30 days

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
  request,
}: {
  method: string;
  url: string;
  headers: Headers;
  body?: string;
  request: Request;
}): Promise<Response> {
  let response: Response;

  if (method === "POST") {
    response = await fetch(url, request);
    return response;
  } else if (method === "GET") {
    response = await fetch(url, request);
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

const saveRequestToDb = async (
  request: Request,
  response: Response,
  url: string,
  body: { [key: string]: any },
  metadata: { [key: string]: any },
  cached: boolean = false
) => {
  const data: OpenAIResponse = await response.json();

  // waitUntil method is used for sending logs, after response is sent
  const r = prisma.request.create({
    data: {
      openai_id: data.id,
      ip: request.headers.get("x-real-ip") || "",
      url: url,
      method: request.method,
      status: response.status,
      request_headers: JSON.stringify(
        Object.fromEntries(request.headers.entries())
      ),
      request_body: JSON.stringify(body),
      response_headers: JSON.stringify(
        Object.fromEntries(response.headers.entries())
      ),
      response_body: JSON.stringify(data),

      cached: cached,

      // prompt_tokens: data.usage.prompt_tokens,
      // completion_tokens: data.usage.completion_tokens,
      // total_tokens: data.usage.total_tokens,
      metadata: {
        create: [
          ...Object.entries(metadata || {}).map(([key, value]) => ({
            key: key,
            value: value,
          })),
        ],
      },
    },
  });

  return r;
};

const logHeaders = async (headers: Headers) => {
  console.log(
    JSON.stringify(Object.fromEntries(headers.entries()), null, 2),
    "\n"
  );
};

async function handleEvent(event: FetchEvent): Promise<Response> {
  const { request } = event;
  const headers = request.headers;
  const body = await request.clone().text();
  const method = request.method;

  const url = await getUrl(request);

  let metadata: { [key: string]: string } = {};
  let restBody: { [key: string]: any } = {};

  if (method === "POST") {
    let { metadata: meta, ...rest } = JSON.parse(body);
    restBody = rest;
    metadata = meta;

    const cacheUrl = new URL(request.url);
    const hash = await sha256(body);
    cacheUrl.pathname = "/posts" + cacheUrl.pathname + "/" + hash;
    console.log("Cache url path: ", cacheUrl.pathname);

    const cacheKey = new Request(cacheUrl.toString(), {
      headers: request.headers,
      method: "GET",
    });

    const cache = caches.default;
    let response = await cache.match(cacheKey);

    logHeaders(headers);

    console.log("Cache key: ", cacheUrl.toString());

    let cached = false;

    if (!response) {
      cached = false;
      console.log("miss");
      const initialResponse = await fetch(url, request);

      logHeaders(initialResponse.headers);

      const headers = new Headers(initialResponse.headers);
      headers.set("cache-control", `public, max-age=${CACHE_AGE}`);

      logHeaders(initialResponse.headers);

      try {
        response = new Response(initialResponse.body, {
          status: initialResponse.status,
          statusText: initialResponse.statusText,
          headers,
        });

        // if (headers.get("llm-cache-enabled") === "true") {
        // console.log("Caching enabled");
        event.waitUntil(cache.put(cacheKey, response.clone()));
      } catch (e) {
        console.error("Error: ", e);
      }
      // }
    } else {
      cached = true;
      console.log("hit");
    }

    event.waitUntil(
      saveRequestToDb(
        request,
        response.clone(),
        url,
        JSON.parse(body),
        metadata,
        cached
      )
    );

    return response;
  }

  return new Response("Method not allowed", { status: 405 });
}

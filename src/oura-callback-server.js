import http from 'node:http';
import { URL } from 'node:url';

import { exchangeOuraCode, writeOuraTokenFile } from './oura-api.js';

function htmlPage(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
</head>
<body>
  <h1>${title}</h1>
  <p>${body}</p>
</body>
</html>
`;
}

export function callbackPathFromRedirectUri(redirectUri, fallbackPath = '/oura/callback') {
  if (!redirectUri) {
    return fallbackPath;
  }
  try {
    const parsed = new URL(redirectUri);
    return parsed.pathname || fallbackPath;
  } catch {
    return fallbackPath;
  }
}

export async function handleOuraCallback({
  code = '',
  state = '',
  error = '',
  expectedState = '',
  clientId,
  clientSecret,
  redirectUri,
  tokenFile,
  exchangeCode = exchangeOuraCode,
  logger = console
}) {
  if (error) {
    return {
      statusCode: 400,
      body: htmlPage('Oura Authorization Failed', `OAuth error: ${error}`)
    };
  }

  if (expectedState && state !== expectedState) {
    return {
      statusCode: 400,
      body: htmlPage('Invalid OAuth State', 'The returned state value did not match the expected request.')
    };
  }

  if (!code) {
    return {
      statusCode: 400,
      body: htmlPage('Missing Authorization Code', 'The callback did not contain an OAuth code.')
    };
  }

  try {
    const tokenPayload = await exchangeCode({
      code,
      clientId,
      clientSecret,
      redirectUri
    });
    writeOuraTokenFile(tokenFile, tokenPayload);

    return {
      statusCode: 200,
      body: htmlPage('Oura Connected', 'The token was stored successfully. You can close this page.'),
      result: {
        tokenFile,
        code,
        tokenPayload
      }
    };
  } catch (errorObject) {
    const message = errorObject instanceof Error ? errorObject.message : String(errorObject);
    logger.error(message);
    throw errorObject;
  }
}

export function startOuraCallbackServer({
  listenHost = '127.0.0.1',
  listenPort = 8787,
  callbackPath = '/oura/callback',
  expectedState = '',
  clientId,
  clientSecret,
  redirectUri,
  tokenFile,
  exchangeCode = exchangeOuraCode,
  logger = console
}) {
  let settled = false;
  let resolveDone;
  let rejectDone;

  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    if (request.method !== 'GET' || requestUrl.pathname !== callbackPath) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }

    try {
      const handled = await handleOuraCallback({
        code: requestUrl.searchParams.get('code') || '',
        state: requestUrl.searchParams.get('state') || '',
        error: requestUrl.searchParams.get('error') || '',
        expectedState,
        clientId,
        clientSecret,
        redirectUri,
        tokenFile,
        exchangeCode,
        logger
      });

      response.writeHead(handled.statusCode, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(handled.body);

      if (!handled.result) {
        return;
      }

      if (!settled) {
        settled = true;
        resolveDone(handled.result);
      }
      server.close();
    } catch (errorObject) {
      const message = errorObject instanceof Error ? errorObject.message : String(errorObject);
      logger.error(message);
      response.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(htmlPage('Token Exchange Failed', message));
      if (!settled) {
        settled = true;
        rejectDone(errorObject);
      }
      server.close();
    }
  });

  const started = new Promise((resolve, reject) => {
    server.once('error', (error) => {
      if (!settled) {
        settled = true;
        rejectDone(error);
      }
      reject(error);
    });
    server.listen(listenPort, listenHost, () => {
      const address = server.address();
      logger.log(`Oura callback listener ready on ${listenHost}:${typeof address === 'object' && address ? address.port : listenPort}${callbackPath}`);
      resolve(address);
    });
  });

  return { server, started, done };
}

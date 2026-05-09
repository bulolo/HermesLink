import Router from "@koa/router";
import { generateSpec } from "../openapi/registry.js";
import { LINK_VERSION } from "../../constants.js";

export function createDocsRouter(): Router {
  const router = new Router();

  router.get("/api/docs/openapi.json", (ctx) => {
    ctx.set("cache-control", "no-store");
    ctx.body = generateSpec(LINK_VERSION);
  });

  router.get("/api/docs", (ctx) => {
    ctx.set("content-type", "text/html; charset=utf-8");
    ctx.set("cache-control", "no-store");
    ctx.body = swaggerUiHtml();
  });

  return router;
}

function swaggerUiHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Hermes Link API Docs</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  <style>
    body { margin: 0; }
    .topbar { display: none; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({
      url: '/api/docs/openapi.json',
      dom_id: '#swagger-ui',
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
      layout: 'BaseLayout',
      deepLinking: true,
      tryItOutEnabled: true,
    });
  </script>
</body>
</html>`;
}

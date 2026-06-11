window.onload = function() {
  window.ui = SwaggerUIBundle({
    url: '/spec/openapi.yaml',
    dom_id: '#swagger-ui',
    deepLinking: true,
    persistAuthorization: true,
    docExpansion: 'none',
    displayRequestDuration: true,
    requestInterceptor: (req) => {
      if (req.url && req.url.startsWith('http://localhost:3001/')) {
        req.headers['X-API-Key'] = 'dev-secret';
      }
      return req;
    },
    presets: [
      SwaggerUIBundle.presets.apis,
      SwaggerUIStandalonePreset
    ],
    layout: 'BaseLayout'
  });
};

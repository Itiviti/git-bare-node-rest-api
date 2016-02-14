var app = require('express')(),
    api = require('./rest-api');

var PORT = process.env['PORT'] || 8080;

api.init(app, {
  repoDir: process.env['REPODIR'],
  installMiddleware: true,
})
app.listen(PORT);
console.log('Listening on', PORT);

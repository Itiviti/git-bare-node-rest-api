require('babel-register');
var app = require('express')();
var api = require('./src/index');

var PORT = process.env['PORT'] || 8080;

api.init(app, {
  repoDir: process.env['REPOSITORIES_DIR'],
  installMiddleware: true
});
app.listen(PORT);
console.log('Listening on', PORT);


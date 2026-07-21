require('babel-register');
var app = require('express')();
var api = require('./src/index');

var PORT = process.env['PORT'] || 8080;
var REPO_DIR = process.env['REPOSITORIES_DIR'];

if (!REPO_DIR) {
  throw 'Please set REPOSITORIES_DIR environment variable';
}

console.log(`Starting git-bare-node-rest-api on port ${PORT}, using repoDir: ${REPO_DIR}`)

api.init(app, {
  repoDir: REPO_DIR,
  installMiddleware: true
});
app.listen(PORT);
console.log('Listening on', PORT);


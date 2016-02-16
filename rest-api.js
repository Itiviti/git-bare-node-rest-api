const  express = require('express'),
    fs = require('fs'),
    path = require('path'),
    Q = require('q'),
    _ = require('lodash'),
    winston = require('winston'),
    dfs = require('./lib/deferred-fs'),
    Rx = require('rx'),
    RxNode = require('rx-node'),
    cors = require('cors'),
    VError = require('verror');

defaultConfig = {
  prefix: '',
  repoDir: '/tmp/git',
  installMiddleware: false,
};

const spawn = require('child_process').spawn;

var logger = new (winston.Logger)({
  transports: [
    new (winston.transports.Console)({ level: 'info', timestamp: true }),
  ],
});

var rxSpawn = function(cmd, args, options) {
    var obs =  Rx.Observable.create(function(observer) {
      var remainder = '';
      function dataHandler(data) {
        var str = data.toString();
        var arr = str.split('\n');
        if (remainder != '') {
          arr[0] = remainder + arr[0];
          remainder = '';
        }
        remainder = arr[arr.length - 1];
        arr = arr.slice(0, arr.length - 1);
        arr.forEach(function(line) { observer.onNext(line); });
      }

      function errorHandler(err) {
        var newError = new VError(err, `spawn error for ${cmd}`);
        console.error(newError.stack);
        observer.onError(newError);
      }

      function endHandler(code) {
        if (!_.isNumber(code) || code >= 2) {
          var err = new VError(`spawn error: ${cmd} process exited with code ${code}`);
          console.error(err.stack);
        }
        if (remainder != '') {
          observer.onNext(remainder);
          remainder = '';
        }
        observer.onCompleted();
      }

      logger.info(`Running ${cmd} in ${options.cwd} with args: ${args.join(' ')}`);
      var childProcess = spawn(cmd, args, options);

      childProcess.stdout.addListener('data', dataHandler);
      childProcess.stderr.addListener('data', errorHandler);
      childProcess.addListener('close', endHandler);

      return function() {
        childProcess.kill();
      };
    });
    return obs.publish().refCount();
  };

var rxGit = function(repoPath, args) {
  return rxSpawn('git', ['-c', 'color.ui=false', '-c', 'core.quotepath=false', '-c', 'core.pager=cat'].concat(args), { cwd: repoPath, stdio: ['ignore', 'pipe', 'pipe'] });
}

function mergeConfigs(dst, src) {
  /* XXX good enough */
  for (var p in src) {
    if (!src.hasOwnProperty(p) || src[p] === undefined) continue;
    if (dst.hasOwnProperty(p) && dst[p] !== undefined) continue;
    /* A property is not defined -- set the default value */
    dst[p] = src[p];
  }
}

exports.init = function(app, config) {

mergeConfigs(config, defaultConfig);

if (config.installMiddleware) {
  app.use(express.bodyParser({ uploadDir: '/tmp', keepExtensions: true }));
  app.use(express.methodOverride());
  app.use(express.cookieParser('a-random-string-comes-here'));
  app.use(cors({exposedHeaders: ['Transfer-Encoding']}));
}

function prepareGitVars(req, res, next) {
  req.git = { };
  next();
}

function getRepos(req, res, next) {
  var repo = req.params.repos;
  var workDir = config.repoDir;
  if (repo.startsWith("^")){
    var match = new RegExp(repo);
    dfs.readdir(workDir)
      .then(
        function(repoList) { req.git.trees = repoList.filter(function(dir) { return match.exec(dir); }); next(); },
        function(error) { reg.json(400, { error: error }); });
  } else {
    dfs.exists(path.join(config.repoDir, repo))
      .then(
        function(exists) {
          if (exists) {
            req.git.trees = [ repo ];
            return true;
          } else {
            return dfs.exists(path.join(config.repoDir, repo + '.git'))
              .then(function(exists) { if (exists) { req.git.trees = [ repo + '.git' ]; } return exists; });
          }
       })
      .then(function(exists) { if (exists) next(); else reg.json(400, { error: error }); })
      .catch(function(error) { reg.json(400, { error: error }); });
  }
}

/* GET /
 *
 * Response:
 *   json: [ (<repo-name>)* ]
 * Error:
 *   json: { "error": <error> }
 */
app.get(config.prefix + '/',
  [prepareGitVars],
  function(req, res)
{
  var workDir = config.repoDir;

  logger.info('list repositories');

  dfs.readdir(workDir)
    .then(
      function(repoList) { res.json(repoList); },
      function(error) { reg.json(400, { error: error }); }
    );
});

/* GET /repo/:repo
 *
 * Response:
 *   json: {}
 * Error:
 *   json: { "error": <error> }
 */
app.get(config.prefix + '/repo/:repos',
  [prepareGitVars, getRepos],
  function(req, res)
{
  var repos = req.git.trees;

  logger.info('get repos:', req.git.trees);

  res.json(200, repos);
});

var parseGitGrep = function(line) {
  var split = line.split(':');
  return { branch: split[0], file: split[1], line_no: split[2], line: split.splice(3).join(':')};
}

var parseGitBranch = function(text) {
  if (row.trim() == '') return;
  var branch = { name: row.slice(2) };
  if(row[0] == '*') branch.current = true;
  return branch;
}

var getBranches = function(repoDir, spec) {
  if (spec[0] == '^') {
    var match = new RegExp(spec);
    return rxGit(repoDir, ['branch', '--list'])
      .map(function(line) { return parseGitBranch(line).name;})
      .filter(function(br) { return match.exec(br); })
      .toArray();
  } else {
    return Rx.Observable.return([spec]);
  }
}

var observeToResponse = function(res, delimiter) {
  var replacer = app.get('json replacer');
  var spaces = app.get('json spaces');
  var noDelim = delimiter === '';
  return Rx.Observer.create(function(val) {
      var body = JSON.stringify(val, replacer, spaces);
      if (!res.headersSent) {
        res.status(200).set('Content-Type', 'application/json');
        if (noDelim) res.write('[');
      } else {
        if (noDelim) res.write(',');
        else res.write(delimiter);
      }
      res.write(body);
    }, function(e) {
      if (res.headersSent) {
        throw e;
      } else {
        res.status(400).json({ error: e });
      }
    }, function() {
      if (!res.headersSent) {
        res.status(200).set('Content-Type', 'application/json');
        if (noDelim) res.write('[');
      }
      if (noDelim) res.write(']');
      res.end();
    })
}

app.get(config.prefix + '/repo/:repos/grep/:branches',
  [prepareGitVars, getRepos],
  function(req, res)
{
  var repos = req.git.trees;
  var q    = req.query.q    || '.';
  var files = req.query.path || '*';
  var ignore_case = req.query.ignore_case ? ['-i'] : [];
  var pattern_type = req.query.pattern_type || 'basic';
  var target_line_no = req.query.target_line_no || 0;
  var delimiter = req.query.delimiter || '';
  var close = Rx.Observable.fromEvent(req, 'close');
  Rx.Observable.from(repos)
    .concatMap(function(repo) {
      var repoDir = path.join(config.repoDir, repo);
      return getBranches(repoDir, req.params.branches)
        .concatMap(function(list) {
          var greps = rxGit(repoDir, ['-c', 'grep.patternType=' + pattern_type, 'grep', '-In'].concat(ignore_case).concat([q]).concat(list).concat('--').concat(files))
            .map(function(line) {
                var ret = parseGitGrep(line);
                ret.repo = repo;
                return ret;
            }).onErrorResumeNext(Rx.Observable.empty());
          if (target_line_no == 0) {
            return greps;
          }
          return greps.filter(function(grep) { return grep.line_no == target_line_no; });
        });
    })
    .takeUntil(close)
    .subscribe(observeToResponse(res, delimiter));
});

}

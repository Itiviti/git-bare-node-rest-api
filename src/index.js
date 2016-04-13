import _ from 'lodash';
import express from 'express';
import path from 'path';
import winston from 'winston';
import dfs from '../lib/deferred-fs';
import Rx from 'rx';
import cors from 'cors';
import { spawn } from 'spawn-rx';
import { Repository, Commit, Diff } from 'nodegit';

var defaultConfig = {
  prefix: '',
  repoDir: '/tmp/git',
  installMiddleware: false
};

var logger = new (winston.Logger)({
  transports: [
    new (winston.transports.Console)({ level: 'info', timestamp: true })
  ]
});

function rxSpawn(cmd, args, options) {
  var remainder = '';
  var obs = spawn(cmd, args, _.assign({}, options, { split: true }))
    .filter(x => x.source === 'stdout')
    .pluck('text')
    .concatMap(function (str) {
      var arr = str.split('\n');
      if (remainder != '') {
        arr[0] = remainder + arr[0];
        remainder = '';
      }
      remainder = arr[arr.length - 1];
      return arr.slice(0, arr.length - 1);
    }).concat(Rx.Observable.create(function(observer) {
      if (remainder != '') {
        observer.onNext(remainder);
      }
      observer.onCompleted();
    }));

  return obs.publish().refCount();
}

function rxGit(repoPath, args) {
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
          function(error) { res.json(400, { error: error.message }); });
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
        .then(function(exists) { if (exists) next(); else res.json(400, { error: `repo ${repo} not found` }); })
        .catch(function(error) { res.json(400, { error: error.message }); });
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
          function(error) { res.json(400, { error: error.message }); }
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
    
  app.get(config.prefix + '/repos/:repos/commits/:sha',
    [prepareGitVars, getRepos],
    function(req, res)
    {
      var repos = req.git.trees;
      var sha = req.params.sha;
      Rx.Observable.from(repos)
      .flatMap(repo => Repository.open(path.join(config.repoDir, repo)))
      .flatMap(repo => Commit.lookup(repo, sha) )
      .flatMap(commit =>
        Rx.Observable.fromPromise(commit.getDiff())
        .flatMap(diffs => diffs) // Diff
        .flatMap(diff => Rx.Observable.fromPromise(diff.patches())
          .flatMap(patches => patches) // ConvenientPatch
          .flatMap(patch => Rx.Observable.fromPromise(patch.hunks())
            .flatMap(hunks => hunks) // ConvenientPatch
            .flatMap(hunk => Rx.Observable.fromPromise(hunk.lines())
              .flatMap(lines => lines) // DiffLine
              .map(line => String.fromCharCode(line.origin())+line.content())
              .toArray().map(lines => ({
                content: hunk.header()+lines.join(''),
                oldStart: hunk.oldStart(),
                oldLines: hunk.oldLines(),
                newStart: hunk.newStart(),
                newLines: hunk.newLines()
              }))
            )
            .toArray().map(hunks => ({
              additions: patch.lineStats().total_additions,
              deletions: patch.lineStats().total_deletions,
              changes: patch.lineStats().total_additions + patch.lineStats().total_deletions,
              from: patch.oldFile().path(),
              to: patch.newFile().path(),
              new: patch.isAdded(),
              deleted: patch.isDeleted(),
              chunks: hunks
            }))
          )
          .toArray().map(patches => ({diff: diff, patches: patches}))
        )
        .toArray().map(diffs => ({commit: commit, diffs: diffs}))
      )
      .subscribe(x => {
        var c = x.commit;
        var au = c.author(), cm = c.committer();
        res.json(200, {
          sha: c.sha(),
          commit: {
            author: { name: au.name(), email: au.email(), date: au.when().time() },
            committer: { name: cm.name(), email: cm.email(), date: cm.when().time() },
            message: c.message()
          },
          parents: c.parents().map(p => ({sha: p.toString()})),
          files: x.diffs[0].patches
        });
      });
    });



  function parseGitGrep(line) {
    var split = line.split(':');
    return { branch: split[0], file: split[1], line_no: split[2], line: split.splice(3).join(':')};
  }

  function parseGitBranch(row) {
    if (row.trim() == '') return;
    var branch = { name: row.slice(2) };
    if(row[0] == '*') branch.current = true;
    return branch;
  }

  function getBranches(repoDir, spec) {
    if (spec[0] == '^') {
      var match = new RegExp(spec);
      return rxGit(repoDir, ['branch', '--list'])
        .map((line) => parseGitBranch(line).name)
        .filter((br) => match.exec(br))
        .toArray();
    } else {
      return Rx.Observable.return([spec]);
    }
  }

  function observeToResponse(res, delimiter) {
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
        res.status(400).json({ error: e.message });
      }
    }, function() {
      if (!res.headersSent) {
        res.status(200).set('Content-Type', 'application/json');
        if (noDelim) res.write('[');
      }
      if (noDelim) res.write(']');
      res.end();
    });
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
        .concatMap((repo) => {
          var repoDir = path.join(config.repoDir, repo);
          return getBranches(repoDir, req.params.branches)
            .concatMap((list) => {
              var greps = rxGit(repoDir, ['-c', 'grep.patternType=' + pattern_type, 'grep', '-In'].concat(ignore_case).concat([q]).concat(list).concat('--').concat(files))
                .map((line) => {
                  var ret = parseGitGrep(line);
                  ret.repo = repo;
                  return ret;
                });
              if (target_line_no == 0) {
                return greps;
              }
              return greps.filter((grep) => grep.line_no == target_line_no);
            })
            .doOnError(e => console.error(e))
            .onErrorResumeNext(Rx.Observable.empty());
        })
        .takeUntil(close)
        .subscribe(observeToResponse(res, delimiter));
    });
};

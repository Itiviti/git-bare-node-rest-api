import _ from 'lodash';
import express from 'express';
import path from 'path';
import winston from 'winston';
import dfs from '../lib/deferred-fs';
import Rx from 'rxjs/Rx';
import cors from 'cors';
import { spawn } from 'spawn-rx';
import { Repository, Commit, Diff, Cred } from 'nodegit';
var cookieParser = require('cookie-parser');
var methodOverride = require('method-override');

var defaultConfig = {
  prefix: '',
  repoDir: process.env['REPOSITORIES_DIR'] || '/tmp/git',
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
        observer.next(remainder);
      }
      observer.complete();
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
    app.use(methodOverride());
    app.use(cookieParser('a-random-string-comes-here'));
    app.use(cors({exposedHeaders: ['Transfer-Encoding']}));
  }

  function prepareGitVars(req, res, next) {
    req.git = { };
    next();
  }

  function getRepo(req, res, next) {
    var repo = req.params.repo;
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
        .then(function(exists) { if (exists) next(); else res.status(400).json({ error: `repo ${repo} not found` }); })
        .catch(function(error) { res.status(400).json({ error: error.message }); });
  }

  function getRepos(req, res, next) {
    var repo = req.params.repos;
    var workDir = config.repoDir;
    if (repo.startsWith("^")){
      var match = new RegExp(repo);
      dfs.readdir(workDir)
        .then(
          function(repoList) { req.git.trees = repoList.filter(function(dir) { return match.exec(dir); }); next(); },
          function(error) { res.status(400).json({ error: error.message }); });
    } else {
      req.params.repo = repo;
      getRepo(req, res, next);
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
          function(error) { res.status(400).json({ error: error.message }); }
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

      res.status(200).json(repos);
    });


  /* GET /repo/:repo/branch
  *
  * Response:
  *   json: [ (<branch name>)* ]
  * Error:
  *   json: { "error": <error> }
  */
  app.get(config.prefix + '/repo/:repo/branch',
    [prepareGitVars, getRepo],
    function(req, res)
    {
      logger.info('list branches');

      var repoDir = path.join(config.repoDir, req.git.trees[0]);
      getBranches(repoDir, '^')
        .flatMap(branches => branches)
        .subscribe(observeToResponse(res, ''));
    });

  /* GET /repo/:repo/show/<path>?rev=<revision>
  *  `rev` -- can be any legal revision
  *
  * Response:
  *   <file contents>
  * Error:
  *   json: { "error": <error> }
  */
  app.get(config.prefix + '/repo/:repo/show/*',
    [prepareGitVars, getRepo],
    function(req, res)
    {
      // Path form: <PREFIX>/repo/<repo>/tree/<path>
      //               0      1     2     3     4
      var pathNoPrefix = req.path.substr(config.prefix.length);
      var filePath = pathNoPrefix.split('/').slice(4).join(path.sep);

      /* get rid of trailing slash */
      filePath = path.normalize(filePath + '/_/..');
      if (filePath === '/') filePath = '';

      filePath = filePath.replace(/\\/g, '/');

      var rev = 'HEAD';
      if (req.query.rev) {
        rev = req.query.rev;
      }

      logger.info(`showing ${filePath} file info for rev ${rev}`);

      var repoDir = path.join(config.repoDir, req.git.trees[0]);
      rxGit(repoDir, ['show', rev + ':' + filePath])
        .subscribe(observeToResponse(res, ''));
    });

  /* GET /repo/:repo/show-ref
  *
  * Response:
  *   json: [ ({"sha":<sha>, "name":<name>})* ]
  * Error:
  *   json: { "error": <error> }
  */
  app.get(config.prefix + '/repo/:repo/show-ref',
    [prepareGitVars, getRepo],
    function(req, res)
    {
      // Path form: <PREFIX>/repo/<repo>
      //               0      1     2

      var repoDir = path.join(config.repoDir, req.git.trees[0]);
      rxGit(repoDir, ['show-ref'])
        .map(line => line.split(' '))
        .map(([sha, name]) => ({sha, name}))
        .subscribe(observeToResponse(res, ''));
    });

   app.get(config.prefix + '/repos/:repos/commits/:sha',
    [prepareGitVars, getRepos],
    function(req, res)
    {
      var repos = req.git.trees;
      var sha = req.params.sha;
      Rx.Observable.from(repos)
      .flatMap(repo => Repository.open(path.join(config.repoDir, repo)))
      .flatMap(repo =>
        Rx.Observable.defer(() => Commit.lookup(repo, sha))
/* untested stuff
.do(console.log)
          .onErrorResumeNext(Rx.Observable.defer(() => { var url = `ssh://repo:${repo.path().replace(config.repoDir, '/home/git')}`;console.log(url);return repo.fetch(url, {
            callbacks: {
              credentials: function(url, userName) {
                console.log(url);
                return Cred.sshKeyFromAgent(userName);
              }
            }
          });})
.do(console.log)
.flatMap(Rx.Observable.defer(() => Commit.lookup(repo, sha))))
*/
      )
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
      .map(x => {
        var c = x.commit;
        var au = c.author(), cm = c.committer();
        return {
          sha: c.sha(),
          commit: {
            author: { name: au.name(), email: au.email(), date: au.when().time() },
            committer: { name: cm.name(), email: cm.email(), date: cm.when().time() },
            message: c.message()
          },
          parents: c.parents().map(p => ({sha: p.toString()})),
          files: x.diffs[0].patches
        };
      })
      .subscribe(observeToResponse(res, ' '));
    });

    /* GET /repo/:repo/show-branch?rev=<rev>[&rev=<rev>...]
    *
    * Response:
    *   json: [ ({ "rev": <rev>, "commits": [ ({ "sha": <sha>, "message": <message> })* ] })* ]
    */
    app.get(config.prefix + '/repo/:repo/show-branch',
        [prepareGitVars, getRepo],
        function(req, res) {
          const result = [];
          const revs = Array.isArray(req.query.rev) ? req.query.rev : [req.query.rev];
          const repoDir = path.join(config.repoDir, req.git.trees[0]);
          rxGit(repoDir, ['show-branch', '--sha1-name', '--sparse'].concat(revs))
              .map(line => ({
                headerMatch: /\s*!\s*\[(\w+)].*/.exec(line),
                bodyMatch: /^[-+\s*]+\[(\w+)].*/.exec(line),
                line
              }))
              .do(line => {
                const match = line.headerMatch || line.bodyMatch;
                if (match) {
                  line.commitId = match[1];
                }
              })
              .filter(line => line.commitId)
              .concatMap(line => rxGit(repoDir, ['log', '--format=%B', '-n', '1', line.commitId])
                  .toArray()
                  .map(commitMessage => ({ ...line, commitMessage: commitMessage.join('\n') })))
              .do(line => {
                if (line.headerMatch) {
                  result.push({
                    rev: line.headerMatch[1],
                    commits: []
                  });
                }
                if (line.bodyMatch) {
                  let i = 0;
                  while (i < result.length) {
                    if (line.line[i] === '+' || line.line[i] === '-') {
                      result[i].commits.push({ sha: line.bodyMatch[1], message: line.commitMessage });
                    }
                    i++;
                  }
                }
              })
              .subscribe(null, null, () => res.status(200).json(result));
        });

  function parseGitGrep(line, null_sep) {
    var branch = line.split(':', 1)[0];
    line = line.substring(branch.length+1);
    if (null_sep) {
      var split = line.split('\0');
      return { branch, file: split[0], line_no: split[1], line: split[2]};
    }
    return { branch, file: line };
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
      return Rx.Observable.of([spec]);
    }
  }

  function observeToResponse(res, delimiter) {
    var replacer = app.get('json replacer');
    var spaces = app.get('json spaces');
    var noDelim = delimiter === '';
    return Rx.Subscriber.create(function(val) {
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
      var max_depth = req.query.max_depth || -1;
      var context = req.query.context || 0;
      var invert = req.query.invert ? ['-v'] : [];
      var mode = req.query.mode ? [`--${req.query.mode}`] : [];
      var close = Rx.Observable.fromEvent(req, 'close');
      var null_sep = req.query.mode ? false : true;
      Rx.Observable.from(repos)
        .concatMap(repo => {
          var repoDir = path.join(config.repoDir, repo);
          return getBranches(repoDir, req.params.branches)
            .concatMap(list => {
              var greps = rxGit(repoDir,
                ['-c', 'grep.patternType=' + pattern_type, 'grep', null_sep ? '-Inz' : '-In', '-C', context, '--max-depth', max_depth]
                  .concat(ignore_case)
                  .concat(invert)
                  .concat(mode)
                  .concat('-e')
                  .concat(q)
                  .concat(list)
                  .concat('--')
                  .concat(files))
                .filter(line => line != '--')
                .map(line => _.assign({repo},  parseGitGrep(line, null_sep)));
              if (target_line_no == 0) {
                return greps;
              }
              return greps.filter(grep => grep.line_no == target_line_no);
            })
            .do(null, e => console.error(e))
            .onErrorResumeNext(Rx.Observable.empty());
        })
        .takeUntil(close)
        .subscribe(observeToResponse(res, delimiter));
    });
};

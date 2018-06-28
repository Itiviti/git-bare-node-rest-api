[![Build Status](https://travis-ci.org/Ullink/git-bare-node-rest-api.svg)](https://travis-ci.org/Ullink/git-bare-node-rest-api)

# GIT BARE NODE REST API

The aim of the project is to provide a readonly restful Git API over a set of bare repositories.

```shell
# returns all repositories hosted
GET /
  [ "foo.git", "bar.git" ]

# returns all repositories matching regexp
GET /repo/^foo
  [ "foo.git" ]

# the real deal comes now:
# executes git grep over matching repositories/path/refspec and return results
GET /repo/^foo/grep/HEAD?q=SOMETHING&path=*.md
  [ {
    "branch": "HEAD",
    "file": "README.cs",
    "line_no": "128",
    "line": "Now this is really SOMETHING",
    "repo": "foo.git"
  } ... ]
```

## Frontend

You can use this service from the [git-react-client](https://github.com/Ullink/git-react-client) React UI.

## Install

You can run it manually using `npm start`, or use [~~forever~~](https://www.npmjs.com/package/forever)/[pm2](http://pm2.keymetrics.io/) to keep it running.

Set the `REPOSITORIES_DIR` env variable to the folder containing your bare repositories.

## Credits

Project was initially forked from [git-rest-api](https://github.com/korya/node-git-rest-api) but has cut most of the ties now.

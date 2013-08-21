var winston = require('winston');
var child_process = require('child_process');
var gitParser = require('./git-parser');
var async = require('async');
var path = require('path');
var fs = require('fs');
var config = require('./config')();

var gitConfigNoColors = '-c color.ui=false';

var gitQueue = async.queue(function (task, callback) {

  var process = child_process.exec(task.command, { cwd: task.repoPath, maxBuffer: 1024 * 1024 * 10 },
    function (error, stdout, stderr) {
      if (error !== null) {
        var err = { errorCode: 'unknown', command: task.command, error: error.toString(), stderr: stderr, stdout: stdout };
        if (stderr.indexOf('Not a git repository') >= 0)
          err.errorCode = 'not-a-repository';
        else if (err.stderr.indexOf('Connection timed out') != -1)
          err.errorCode = 'remote-timeout';
        else if (err.stderr.indexOf('Permission denied (publickey)') != -1)
          err.errorCode = 'permision-denied-publickey';
        else if (err.stdout.indexOf('CONFLICT (content): Merge conflict in') != -1)
          err.errorCode = 'conflict';
        task.error = err;
        callback(err);
      }
      else {
        task.result = task.parser ? task.parser(stdout) : stdout;
        callback();
      }
  });

  if (task.onStarted) task.onStarted(process);

}, config.maxConcurrentGitOperations);

var git = function(command, repoPath, parser, callback, onStarted) {
  if (typeof(callback) != 'function') throw new Error('Callback must be function');
  command = 'git ' + gitConfigNoColors + ' ' + command;
  winston.info('Executing ' + command);

  var task = {
    command: command,
    repoPath: repoPath,
    parser: parser,
    onStarted: onStarted
  };

  gitQueue.push(task, function() {
    callback(task.error, task.result);
  });
}

git.status = function(repoPath, callback) {
  git('status -s -b -u', repoPath, gitParser.parseGitStatus, function(err, status) {
    if (err) {
      callback(err, status);
      return;
    }
    // From http://stackoverflow.com/questions/3921409/how-to-know-if-there-is-a-git-rebase-in-progress
    status.inRebase = fs.existsSync(path.join(repoPath, '.git', 'rebase-merge')) ||
      fs.existsSync(path.join(repoPath, '.git', 'rebase-apply'));

    status.inMerge = fs.existsSync(path.join(repoPath, '.git', 'MERGE_HEAD'));

    if (status.inMerge) {
      status.commitMessage = fs.readFileSync(path.join(repoPath, '.git', 'MERGE_MSG'), { encoding: 'utf8' });
    }

    callback(null, status);
  });
}
git.remoteShow = function(repoPath, remoteName, callback) {
  git('remote show ' + remoteName, repoPath, gitParser.parseGitRemoteShow, callback);
}
git.stashAndPop = function(repoPath, performCallback, callback) {
  if (typeof(performCallback) != 'function') throw new Error('performCallback must be function');
  var hadLocalChanges = true;
  async.series([
    function(done) {
      git('stash', repoPath, undefined, function(err, res) {
        if (err) {
          done(err);
        } else {
          if (res.indexOf('No local changes to save') != -1) {
            hadLocalChanges = false;
            done();
          } else {
            done();
          }
        }
      });
    },
    function(done) {
      performCallback(done);
    },
    function(done) {
      if(!hadLocalChanges) done(); 
      else git('stash pop', repoPath, undefined, done);
    },
  ], function(err, result) {
    callback(err, result);
  });
}

module.exports = git;

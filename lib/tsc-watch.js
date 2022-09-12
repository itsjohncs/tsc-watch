#!/usr/bin/env node

'use strict';
const nodeCleanup = require('node-cleanup');
const spawn = require('cross-spawn');
const run = require('./runner');
const { extractArgs } = require('./args-manager');
const { manipulate, detectState, deleteClear, print } = require('./stdout-manipulator');
const readline = require('readline');

let firstTime = true;
let firstSuccessKiller = null;
let successKiller = null;
let failureKiller = null;
let compilationStartedKiller = null;
let compilationCompleteKiller = null;

const {
  onFirstSuccessCommand,
  onSuccessCommand,
  onFailureCommand,
  onCompilationStarted,
  onCompilationComplete,
  maxNodeMem,
  noColors,
  noClear,
  silent,
  compiler,
  args,
} = extractArgs(process.argv);

function kill(killer) {
  if (killer) {
    return killer();
  } else {
    return null;
  }
}

async function restart(killer, handler) {
  await kill(killer);
  return run(handler);
}

function killProcesses(killAll) {
  return Promise.all([
    killAll && kill(firstSuccessKiller),
    kill(successKiller),
    kill(failureKiller),
    kill(compilationStartedKiller),
    kill(compilationCompleteKiller),
  ]);
}

async function runOnCompilationStarted() {
  if (onCompilationStarted) {
    compilationStartedKiller = await restart(compilationStartedKiller, onCompilationStarted);
  }
}

async function runOnCompilationComplete() {
  if (onCompilationComplete) {
    compilationCompleteKiller = await restart(compilationCompleteKiller, onCompilationComplete);
  }
}

async function runOnFailureCommand() {
  if (onFailureCommand) {
    failureKiller = await restart(failureKiller, onFailureCommand);
  }
}

async function runOnFirstSuccessCommand() {
  if (onFirstSuccessCommand) {
    firstSuccessKiller = await restart(firstSuccessKiller, onFirstSuccessCommand);
  }
}

async function runOnSuccessCommand() {
  if (onSuccessCommand) {
    successKiller = await restart(successKiller, onSuccessCommand);
  }
}

function buildNodeParams(allArgs, { maxNodeMem }){
  let tscBin;
  try {
    tscBin = require.resolve(compiler);
  } catch (e) {
    if (e.code === 'MODULE_NOT_FOUND') {
      console.error(e.message);
      process.exit(9);
    }
    throw e;
  }

  return [
    ...((maxNodeMem) ? [`--max_old_space_size=${maxNodeMem}`] : []),
    tscBin,
    ...allArgs,
  ];
}

let compilationErrorSinceStart = false;
const tscProcess = spawn('node', buildNodeParams(args, { maxNodeMem }));
const rl = readline.createInterface({
  input: tscProcess.stdout,
});

rl.on('line', function (input) {
  if (noClear) {
    input = deleteClear(input);
  }

  const line = manipulate(input);
  if (!silent) {
    print(noColors, noClear, line);
  }
  const state = detectState(line);
  const compilationStarted = state.compilationStarted;
  const compilationError = state.compilationError;
  const compilationComplete = state.compilationComplete;

  compilationErrorSinceStart = (!compilationStarted && compilationErrorSinceStart) || compilationError;

  if (state.fileEmitted !== null){
    Signal.emitFile(state.fileEmitted);
  }

  if (compilationStarted) {
    runOnCompilationStarted();
    Signal.emitStarted();
  }

  if (compilationComplete) {
    runOnCompilationComplete();

    if (compilationErrorSinceStart) {
      Signal.emitFail();
      runOnFailureCommand();
    } else {
      if (firstTime) {
        firstTime = false;
        Signal.emitFirstSuccess();
        runOnFirstSuccessCommand();
      }

      Signal.emitSuccess();
      runOnSuccessCommand();
    }
  }
});

if (typeof process.on === 'function') {
  process.on('message', (msg) => {
    let promise;
    let func;
    switch (msg) {
      case 'run-on-compilation-started-command':
        promise = compilationStartedKiller ? compilationStartedKiller() : Promise.resolve();
        func = runOnCompilationStarted;
        break;

      case 'run-on-compilation-complete-command':
        promise = compilationCompleteKiller ? compilationCompleteKiller() : Promise.resolve();
        func = runOnCompilationComplete;
        break;

      case 'run-on-first-success-command':
        promise = firstSuccessKiller ? firstSuccessKiller() : Promise.resolve();
        func = runOnFirstSuccessCommand;
        break;

      case 'run-on-failure-command':
        promise = failureKiller ? failureKiller() : Promise.resolve();
        func = runOnFailureCommand;
        break;

      case 'run-on-success-command':
        promise = successKiller ? successKiller() : Promise.resolve();
        func = runOnSuccessCommand;
        break;

      default:
        console.log('Unknown message', msg);
    }

    if (func) {
      promise.then(func);
    }
  });
}

const Signal = {
  send: typeof process.send === 'function' ? (...e) => process.send(...e) : () => { },
  emitStarted: () => Signal.send('started'),
  emitFirstSuccess: () => Signal.send('first_success'),
  emitSuccess: () => Signal.send('success'),
  emitFail: () => Signal.send('compile_errors'),
  emitFile: (path) => Signal.send(`file_emitted:${path}`),
};

nodeCleanup((_exitCode, signal) => {
  tscProcess.kill(signal);
  killProcesses(true).then(() => process.exit());
  // don't call cleanup handler again
  nodeCleanup.uninstall();
  return false;
});

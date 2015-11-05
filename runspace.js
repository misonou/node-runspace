/*jshint node:true,newcap:true,regexp:true */

'use strict';

var EventEmitter = require('events').EventEmitter;
var fs = require('fs');
var path = require('path');
var timers = require('timers');
var util = require('util');
var vm = require('vm');

var ModuleLoader = require('./module-loader');
var Proxy = require('./proxy');
var Map = require('./map');
var WeakMap = require('./weak-map');

var setTimeoutCtor = setTimeout(function () {}).constructor;
var setImmediateCtor = setImmediate(function () {}).constructor;

var GLOBALS = {
    get console() {
        return console;
    },
    Buffer: Buffer,
    Int8Array: Int8Array,
    Int16Array: Int16Array,
    Int32Array: Int32Array,
    Uint8Array: Uint8Array,
    Uint8ClampedArray: Uint8ClampedArray,
    Uint16Array: Uint16Array,
    Uint32Array: Uint32Array,
    Float64Array: Float64Array,
    ArrayBuffer: ArrayBuffer
};

var fsArgCheck = {};
Object.getOwnPropertyNames(fs).forEach(function (i) {
    var checkArg1 = i.charAt(0) !== 'f' && ['read', 'readSync', 'write', 'writeSync'].indexOf(i) < 0;
    var checkArg2 = checkArg1 && ['rename', 'renameSync', 'link', 'linkSync'].indexOf(i) >= 0;
    fsArgCheck[i] = (checkArg1 && 1) | (checkArg2 && 2);
});

function clearArray(arr) {
    arr.splice(0, arr.length);
}

function isContained(basedir, dirname) {
    return path.relative(basedir, dirname).indexOf('..' + path.sep) < 0;
}

function throwError(code, message) {
    var err = new Error(util.format.apply(null, Array.prototype.slice.call(arguments, 1)));
    err.code = code;
    throw err;
}

function throwIfEAcces(basedir, filename) {
    filename = path.resolve(filename);
    if (!isContained(basedir, filename)) {
        throwError('EACCES', 'Access to %s is blocked', filename);
    }
}

function Runspace(scope, options) {
    Proxy.call(this);
    options = options || {};

    var self = this;
    self.scope = path.resolve(scope);
    self.moduleLoader = new ModuleLoader(self, {
        deny: ['cluster', 'child_process', 'repl'],
        loadPaths: options.loadPaths
    });
    self.processEE = new EventEmitter();

    var listeners = new Map();
    var timerCallbacks = {
        immediate: [],
        interval: [],
        timeout: []
    };

    // setup global context in user-code space
    self.context = vm.createContext(GLOBALS);
    self.context.global = self.context;

    // setup proxies of built-in modules
    self.add(EventEmitter, {
        call: function (method, fn, args, target, undef) {
            if (self.isWeaklyProxied(target)) {
                return;
            }
            if (target === process) {
                return undef.wrap(fn.apply(self.processEE, args));
            }
            if (!listeners.has(target)) {
                listeners.set(target, []);
            }
            var arr = listeners.get(target);
            var eventType = args[0];
            var callback = args[1];

            switch (method) {
            case 'EventEmitter#on':
            case 'EventEmitter#addListener':
            case 'EventEmitter#once':
                var callbackProxy = function () {
                    if (method.substr(-4) === 'once') {
                        for (var i = 0, length = arr.length; i < length; i++) {
                            if (arr[i].callback === callback) {
                                arr.splice(i, 1);
                                break;
                            }
                        }
                    }
                    callback.apply(this, arguments);
                };
                arr.push({
                    type: eventType,
                    callback: callback,
                    callbackProxy: callbackProxy
                });
                return undef.wrap(fn.call(target, eventType, callbackProxy));
            case 'EventEmitter#removeListener':
            case 'EventEmitter#removeAllListener':
                var checkType = method.indexOf('All') < 0 || eventType;
                var checkCallback = !!callback;
                var idx = [];
                arr.forEach(function (v, i) {
                    if ((!checkType || v.type === eventType) && (!checkCallback || v.callback === callback)) {
                        target.removeListener(eventType, v.callbackProxy);
                        idx.unshift(i);
                    }
                });
                idx.forEach(function (idx) {
                    arr.splice(idx, 1);
                });
                return undef;
            case 'EventEmitter#listeners':
                return arr.filter(function (v) {
                    return v.type === eventType;
                }).map(function (v) {
                    return v.callback;
                });
            case 'EventEmitter#listenerCount':
                return arr.filter(function (v) {
                    return v.type === eventType;
                }).length;
            }
        }
    });

    self.add(setTimeoutCtor, {
        functionType: 'ctor',
        deny: ['#ref']
    });
    self.timers = self.add(timers, {
        call: function (method, fn, args, target, undef) {
            var arr = timerCallbacks[method.substr(method.charAt(0) === 's' ? 3 : 5).toLowerCase()];
            if (method.charAt(0) === 's') {
                if (method !== 'setInterval') {
                    var callback = args[0];
                    args[0] = function () {
                        var idx = arr.indexOf(handle);
                        if (idx >= 0) {
                            arr.splice(idx, 1);
                        }
                        if (callback) {
                            callback.apply(this, arguments);
                        }
                    };
                }
                var handle = fn.apply(null, args);
                if (method !== 'setImmediate') {
                    handle.unref();
                }
                arr.push(handle);
                return undef.wrap(handle);
            } else {
                var idx = arr.indexOf(args[0]);
                if (idx >= 0) {
                    arr.splice(idx, 1);
                }
                return undef.wrap(fn.apply(null, args));
            }
        }
    });
    self.context.setImmediate = self.timers.setImmediate;
    self.context.setInterval = self.timers.setInterval;
    self.context.setTimeout = self.timers.setTimeout;
    self.context.clearImmediate = self.timers.clearImmediate;
    self.context.clearInterval = self.timers.clearInterval;
    self.context.clearTimeout = self.timers.clearTimeout;

    self.context.process = self.add(process, {
        name: 'process',
        deny: ['stdin', 'abort', 'binding', 'chdir', 'dlopen', 'exit', 'setgid', 'setegid', 'setuid', 'seteuid', 'setgroups', 'initgroups', 'kill', 'disconnect', 'mainModule'],
        call: function (method, fn, args, target, undef) {
            if (method === 'send') {
                var message = JSON.parse(JSON.stringify(args[0]));
                self.emit('message', message);
                return undef;
            }
            if (method === 'cwd') {
                return self.scope;
            }
        }
    });
    self.fs = self.add(fs, {
        name: 'fs',
        call: function (method, fn, args) {
            if (fsArgCheck[method] & 1) {
                args[0] = path.resolve(self.scope, args[0]);
                throwIfEAcces(self.scope, args[0]);
            }
            if (fsArgCheck[method] & 2) {
                args[1] = path.resolve(self.scope, args[1]);
                throwIfEAcces(self.scope, args[1]);
            }
        }
    });
    self.add(path, {
        name: 'path',
        call: function (method, fn, args) {
            if (method === 'resolve') {
                args.unshift(self.scope);
            }
        }
    });

    // prevent user-code accessing objects outside runspace.context
    // by accessing internal V8 CallSite objects
    vm.runInContext('Object.defineProperty(Error, \'prepareStackTrace\', { value: undefined })', self.context);

    function forwardExit() {
        self.processEE.emit('exit');
    }
    process.on('exit', forwardExit);
    self.once('terminate', function () {
        process.removeListener('exit', forwardExit);
        self.processEE.emit('exit');
        timerCallbacks.immediate.forEach(clearImmediate);
        timerCallbacks.interval.forEach(clearInterval);
        timerCallbacks.timeout.forEach(clearTimeout);
        clearArray(timerCallbacks.immediate);
        clearArray(timerCallbacks.interval);
        clearArray(timerCallbacks.timeout);
        listeners.forEach(function (v, target) {
            v.forEach(function (v) {
                target.removeListener(v.type, v.callbackProxy);
            });
            clearArray(v);
        });
        listeners.clear();
    });
}
util.inherits(Runspace, Proxy);

Runspace.prototype.isPathAllowed = function (path) {
    return isContained(this.scope, path);
};

Runspace.prototype.send = function (message) {
    message = JSON.parse(JSON.stringify(message));
    this.processEE.emit('message', message);
};

Runspace.prototype.compileScript = function (code, filename) {
    var self = this;
    var dirname = path.dirname(filename);
    var require = self.moduleLoader.requireAt(dirname);
    var dummy = new vm.Script(code);
    var argNames = [];
    var fn;

    return {
        run: function (localVars) {
            Object.keys(localVars).forEach(function (v) {
                if (argNames.indexOf(v) < 0) {
                    argNames.push(v);
                    fn = null;
                }
            });
            if (!fn) {
                var script = new vm.Script('(function (' + ['require', '__filename', '__dirname'].concat(argNames).join(', ') + ') {' + code + '\n});', filename);
                fn = self.proxy(script.runInContext(self.context), {
                    functionType: 'out'
                });
            }
            var argList = argNames.map(function (v) {
                return localVars[v];
            });
            return fn.apply(self.context, [require, filename, dirname].concat(argList));
        }
    };
};

module.exports = Runspace;

/*jshint node:true,newcap:true,regexp:true */

'use strict';

var domain = require('domain');
var EventEmitter = require('events').EventEmitter;
var fs = require('fs');
var path = require('path');
var stream = require('stream');
var timers = require('timers');
var util = require('util');
var vm = require('vm');

var ModuleLoader = require('./module-loader');
var EventManager = require('./event-manager');
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
var PROCESS_DENY = ['abort', 'binding', 'chdir', 'dlopen', 'exit', 'setgid', 'setegid', 'setuid', 'seteuid', 'setgroups', 'initgroups', 'kill', 'disconnect', 'mainModule'];
Array.prototype.push.apply(PROCESS_DENY, Object.getOwnPropertyNames(process).filter(function (v) {
    return v.charAt(0) === '_';
}));

var FS_ARG_CHECK = {};
Object.getOwnPropertyNames(fs).forEach(function (i) {
    var checkArg1 = i.charAt(0) !== 'f' && ['read', 'readSync', 'write', 'writeSync'].indexOf(i) < 0;
    var checkArg2 = checkArg1 && ['rename', 'renameSync', 'link', 'linkSync'].indexOf(i) >= 0;
    FS_ARG_CHECK[i] = (checkArg1 && 1) | (checkArg2 && 2);
});

function isContained(basedir, dirname) {
    return path.relative(basedir, dirname).indexOf('..' + path.sep) < 0;
}

function throwIfEAcces(basedir, filename) {
    filename = path.resolve(filename);
    if (!isContained(basedir, filename)) {
        var err = new Error(util.format('Access to %s is blocked', filename));
        err.code = 'EACCES';
        throw err;
    }
}

function removeItem(arr, value) {
    var idx = arr.indexOf(value);
    if (idx >= 0) {
        return arr.splice(idx, 1)[0];
    }
}

function clear(obj, callback) {
    if (Array.isArray(obj)) {
        obj.splice(0).forEach(callback);
    } else {
        Object.getOwnPropertyNames(obj).forEach(function (i) {
            callback(obj[i], i);
            delete obj[i];
        });
    }
}

function networkIOProxyCall(closeables) {
    return function (method, fn, args, target) {
        if (method === 'createServer' || method === 'createSocket') {
            var server = fn.apply(target, args);
            if (server.unref) {
                server.unref();
            }
            closeables.push(server);
            return server;
        }
        if (method === 'connect' || method === 'createConnection' || method === 'Socket') {
            var socket = fn.apply(target, args);
            socket.close = socket.end;
            socket.unref();
            closeables.push(socket);
            return socket;
        }
        if (method === 'Server#close' || method === 'Socket#close' || method === 'Socket#end') {
            removeItem(closeables, target);
            return;
        }
    };
}

function Pipe() {
    var self = this;
    var queue = [];
    self.readable = new stream.Readable({
        read: function () {
            while (queue[0] && this.push(queue.shift()));
        }
    });
    self.writable = new stream.Writable({
        write: function (data, encoding, callback) {
            var err = null;
            try {
                if (self.readable.listenerCount('data') > 0) {
                    if (!(data instanceof Buffer)) {
                        data = new Buffer(data, encoding);
                    }
                    queue.push(data);
                }
            } catch (ex) {
                err = ex;
            }
            callback(err);
        }
    });
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

    var processEE = new EventEmitter();
    var events = new EventManager();
    var closeables = [];

    var stdin = new Pipe();
    var stdout = new Pipe();
    var stderr = new Pipe();
    self.stdin = stdin.writable;
    self.stdout = stdout.readable;
    self.stderr = stderr.readable;

    // setup proxies of built-in modules
    self.add(EventEmitter, {
        call: function (method, fn, args, target, undef) {
            if (self.isWeaklyProxied(target)) {
                return;
            }
            if (method === 'EventEmitter.listenerCount') {
                target = args.shift();
                fn = EventEmitter.prototype.listenerCount;
            }
            if (target === process) {
                return undef.wrap(fn.apply(processEE, args));
            }
            switch (method) {
            case 'EventEmitter#on':
            case 'EventEmitter#addListener':
            case 'EventEmitter#once':
                if (typeof args[1] !== 'function') {
                    throw new TypeError('listener must be a function');
                }
                events.addListener(target, args[0], args[1], method.substr(-4) === 'once');
                return target;
            case 'EventEmitter#removeListener':
                if (typeof args[1] !== 'function') {
                    throw new TypeError('listener must be a function');
                }
                events.removeListener(target, args[0], args[1]);
                return target;
            case 'EventEmitter#removeAllListeners':
                events.removeAllListeners(target, args[0]);
                return target;
            case 'EventEmitter#listeners':
                return (events.getListeners(target, args[0]) || []).map(function (v) {
                    return v.callback;
                });
            case 'EventEmitter#listenerCount':
            case 'EventEmitter.listenerCount':
                return (events.getListeners(target, args[0]) || '').length;
            }
        }
    });
    self.add(stream);
    self.add(domain);

    var timerCallbacks = {
        immediate: [],
        interval: [],
        timeout: []
    };
    self.add(setTimeoutCtor, {
        functionType: 'ctor',
        deny: ['#ref']
    });
    self.add(timers, {
        call: function (method, fn, args, target, undef) {
            var arr = timerCallbacks[method.substr(method.charAt(0) === 's' ? 3 : 5).toLowerCase()];
            if (method.charAt(0) === 's') {
                var handle;
                if (method !== 'setInterval') {
                    var callback = args[0];
                    args[0] = function () {
                        removeItem(arr, handle);
                        callback.apply(this, arguments);
                    };
                }
                handle = fn.apply(null, args);
                if (handle.unref) {
                    handle.unref();
                }
                arr.push(handle);
                return undef.wrap(handle);
            } else {
                removeItem(arr, args[0]);
                return undef.wrap(fn.apply(null, args));
            }
        }
    });
    self.add(process, {
        name: 'process',
        deny: PROCESS_DENY,
        freeze: true,
        get: function (prop) {
            if (prop === 'stdin') {
                return stdin.readable;
            }
            if (prop === 'stdout') {
                return stdout.writable;
            }
            if (prop === 'stderr') {
                return stderr.writable;
            }
        },
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

    var watchPaths = Object.create(null);
    self.add(fs, {
        name: 'fs',
        call: function (method, fn, args, target, undef) {
            if (FS_ARG_CHECK[method] & 1) {
                args[0] = path.resolve(self.scope, args[0]);
                throwIfEAcces(self.scope, args[0]);
            }
            if (FS_ARG_CHECK[method] & 2) {
                args[1] = path.resolve(self.scope, args[1]);
                throwIfEAcces(self.scope, args[1]);
            }
            if (method === 'FSWatcher#close') {
                removeItem(closeables, target);
                return;
            }
            if (method === 'watch') {
                if (args[1] && args[1].persistent) {
                    throw new Error('Persistent FSWatcher disallowed');
                }
                var watcher = fn.apply(fs, args);
                closeables.push(watcher);
                return watcher;
            }
            if (method === 'watchFile') {
                if (!watchPaths[args[0]]) {
                    watchPaths[args[0]] = [];
                }
                watchPaths[args[0]].push(args[1]);
                return undef.wrap(fn.apply(fs, args));
            }
            if (method === 'unwatchFile') {
                if (watchPaths[args[0]]) {
                    if (args[1]) {
                        removeItem(watchPaths[args[0]], args[1]);
                        return undef.wrap(fn.apply(fs, args));
                    }
                    clear(watchPaths[args[0]], function (v) {
                        fs.unwatchFile(args[0], v);
                    });
                }
                return undef;
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

    var netProxyCall = networkIOProxyCall(closeables);
    self.add(require('dgram'), {
        name: 'dgram',
        deny: ['Socket#ref'],
        call: netProxyCall
    });
    self.add(require('net'), {
        name: 'net',
        deny: ['Server#ref', 'Socket#ref'],
        call: netProxyCall,
        new: netProxyCall
    });
    self.add(require('tls'), {
        name: 'tls',
        call: netProxyCall
    });
    self.add(require('http'), {
        name: 'http',
        call: netProxyCall
    });
    self.add(require('https'), {
        name: 'https',
        call: netProxyCall
    });

    // setup global context in user-code space
    self.context = vm.createContext(GLOBALS);
    self.context.global = self.context;
    self.context.process = self.getProxy(process);

    var timerProxy = self.getProxy(timers);
    self.context.setImmediate = timerProxy.setImmediate;
    self.context.setInterval = timerProxy.setInterval;
    self.context.setTimeout = timerProxy.setTimeout;
    self.context.clearImmediate = timerProxy.clearImmediate;
    self.context.clearInterval = timerProxy.clearInterval;
    self.context.clearTimeout = timerProxy.clearTimeout;

    self._domain = domain.create();
    self._domain.on('error', function (err) {
        self._domain.exit();
        self.emit('error', err);
    });

    // prevent user-code accessing objects outside runspace.context
    // by accessing internal V8 CallSite objects
    vm.runInContext('Object.defineProperty(Error, \'prepareStackTrace\', { value: undefined })', self.context);

    function forwardExit() {
        processEE.emit('exit');
    }
    process.on('exit', forwardExit);
    self.once('terminate', function () {
        process.removeListener('exit', forwardExit);
        events.removeAllListeners();
        clear(timerCallbacks.immediate, clearImmediate);
        clear(timerCallbacks.interval, clearInterval);
        clear(timerCallbacks.timeout, clearTimeout);
        clear(closeables, function (v) {
            v.close();
        });
        clear(watchPaths, function (arr, i) {
            clear(arr, function (v) {
                fs.unwatchFile(i, v);
            });
        });
        processEE.emit('exit');
    });
}
util.inherits(Runspace, Proxy);

Runspace.prototype.isPathAllowed = function (path) {
    return isContained(this.scope, path);
};
Runspace.prototype.send = function (message) {
    message = JSON.parse(JSON.stringify(message));
    this.context.process.emit('message', message);
};
Runspace.prototype.run = function (code, filename, localVars) {
    if (typeof filename === 'object') {
        localVars = filename;
        filename = undefined;
    }
    return this.compile(code, filename).run(localVars);
};
Runspace.prototype.compile = function (code, filename) {
    var self = this;
    var dirname = filename ? path.dirname(filename) : self.scope;
    var require = self.moduleLoader.requireAt(dirname);
    var dummy = new vm.Script(code);
    var argNames = [];
    var fn;

    return {
        run: function (localVars) {
            if (localVars) {
                Object.keys(localVars).forEach(function (v) {
                    if (argNames.indexOf(v) < 0) {
                        argNames.push(v);
                        fn = null;
                    }
                });
            }
            if (!fn) {
                var script = new vm.Script('(function (' + ['require', '__filename', '__dirname'].concat(argNames).join(', ') + ') {' + code + '\n});', filename);
                fn = self.proxy(script.runInContext(self.context), {
                    functionType: 'out'
                });
            }
            var argList = argNames.map(function (v) {
                return localVars[v];
            });
            var returnValue, err;
            self._domain.run(function () {
                try {
                    returnValue = fn.apply(self.context, [require, filename, dirname].concat(argList));
                } catch (ex) {
                    err = ex;
                }
            });
            if (err) {
                throw err;
            }
            return returnValue;
        }
    };
};

module.exports = Runspace;

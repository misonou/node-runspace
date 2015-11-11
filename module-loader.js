/*jshint node:true */

'use strict';

var builtInModules = require('builtin-modules');
var fs = require('fs');
var Module = require('module');
var path = require('path');
var util = require('util');
var vm = require('vm');

var lookupPaths = {};
var realRequire = require;
var requireFS;

function stripBOM(content) {
    // Remove byte order marker. This catches EF BB BF (the UTF-8 BOM)
    // because the buffer-to-string conversion in `fs.readFileSync()`
    // translates it to FEFF, the UTF-16 BOM.
    if (content.charCodeAt(0) === 0xFEFF) {
        content = content.slice(1);
    }
    return content;
}

function throwError(code, message) {
    var err = new Error(util.format.apply(null, Array.prototype.slice.call(arguments, 1)));
    err.code = code;
    throw err;
}

function isFile(filename) {
    try {
        return fs.statSync(filename).isFile() && filename;
    } catch (ex) {
        if (ex.code === 'ENOENT') {
            return false;
        }
        throw ex;
    }
}

function isDirectory(dirname) {
    try {
        return fs.statSync(dirname).isDirectory() && dirname;
    } catch (ex) {
        if (ex.code === 'ENOENT') {
            return false;
        }
        throw ex;
    }
}

function tryExtensions(p, exts) {
    for (var i = 0, length = exts.length; i < length; i++) {
        var filename = isFile(p + exts[i]);
        if (filename) {
            return filename;
        }
    }
}

function tryFile(filename, exts) {
    return isFile(filename) || (!path.extname(filename) && tryExtensions(filename, exts));
}

function tryPackage(dirname, exts) {
    var jsonPath = path.resolve(dirname, 'package.json');
    if (isFile(jsonPath)) {
        try {
            var manifest = JSON.parse(fs.readFileSync(jsonPath));
            if (typeof manifest.main === 'string') {
                var filename = path.resolve(dirname, manifest.main);
                return tryFile(filename, exts) || tryExtensions(path.join(filename, 'index'), exts);
            }
        } catch (ex) {
            ex.path = jsonPath;
            ex.message = 'Error parsing ' + jsonPath + ': ' + ex.message;
            throw ex;
        }
    }
}

function tryDirectory(dirname, exts) {
    return tryPackage(dirname, exts) || tryExtensions(path.join(dirname, 'index'), exts);
}

function requireAt(runspace, loader, dir, parent) {
    var nocheck = !runspace.isPathAllowed(dir);
    var pathCache = loader.pathCache[dir];
    if (!pathCache) {
        pathCache = loader.pathCache[dir] = {};
    }

    function resolveNodeModules(id, exts) {
        var paths = lookupPaths[dir];
        if (!paths) {
            if (nocheck) {
                paths = lookupPaths[dir] = Module._nodeModulePaths(dir).concat(Module.globalPaths);
            } else {
                var filter = runspace.isPathAllowed.bind(runspace);
                paths = lookupPaths[dir] = [];
                paths.push.apply(paths, Module._nodeModulePaths(dir).filter(filter));
                paths.push.apply(paths, loader.loadPaths);
                paths.push.apply(paths, Module.globalPaths.filter(filter));
            }
        }
        for (var i = 0, length = paths.length; i < length; i++) {
            var modulePath = path.join(paths[i], id);
            var filename = tryFile(modulePath, exts) || tryDirectory(modulePath, exts);
            if (filename) {
                return filename;
            }
        }
        throwError('MODULE_NOT_FOUND', 'Cannot find module \'%s\'', id);
    }

    function resolveFilename(id) {
        if (builtInModules.indexOf(id) >= 0) {
            return id;
        }
        var exts = Object.keys(loader.Module.extensions);
        if (id.substr(0, 2) === './' || id.charAt(0) === '/' || id.substr(0, 3) === '../') {
            var absolutePath = path.resolve(dir, id);
            if (nocheck || runspace.isPathAllowed(absolutePath)) {
                return tryFile(absolutePath, exts) || tryDirectory(absolutePath, exts) || resolveNodeModules(id, exts);
            }
        }
        return resolveNodeModules(id, exts);
    }

    function require(id) {
        runspace.throwIfTerminated();
        if (id === 'module') {
            return loader.Module;
        }

        var filename = pathCache[id];
        if (!filename) {
            filename = pathCache[id] = resolveFilename(id);
        }
        if (builtInModules.indexOf(filename) >= 0) {
            if (loader.deny.indexOf(filename) >= 0) {
                throwError('EACCES', 'Access denied to module \'%s\'', id);
            }
            var m = realRequire(filename);
            return runspace.getProxy(m) || runspace.add(m, {
                name: filename
            });
        }
        if (require.cache[filename]) {
            return require.cache[filename].exports;
        }

        var module = require.cache[filename] = new loader.Module(filename, parent || null);
        module.filename = filename;
        module.require = requireAt(runspace, loader, path.dirname(filename), module);
        try {
            requireFS = fs;
            (require.extensions[path.extname(filename)] || require.extensions['.js'])(module, filename);
            module.loaded = true;
            return module.exports;
        } catch (ex) {
            delete require.cache[filename];
            throw ex;
        } finally {
            requireFS = null;
        }
    }

    require.resolve = resolveFilename;
    require.cache = loader.Module.cache;
    require.extensions = loader.Module.extensions;
    return require;
}

function loadScript(runspace, module, filename) {
    var code = (requireFS || runspace.getProxy(fs)).readFileSync(filename, 'utf8');
    var dummy = new vm.Script(code);
    var fn = new vm.Script(Module.wrap(stripBOM(code)), filename).runInContext(runspace.context);
    fn.call(module.exports, module.exports, module.require, module, filename, path.dirname(filename));
}

function loadJSON(runspace, module, filename) {
    var content = (requireFS || runspace.getProxy(fs)).readFileSync(filename, 'utf8');
    try {
        module.exports = JSON.parse(stripBOM(content));
    } catch (ex) {
        ex.message = filename + ': ' + ex.message;
        throw ex;
    }
}

function loadNative(runspace, module, filename) {
    (requireFS || runspace.getProxy(fs)).statSync(filename);
    module.exports = process.dlopen(module, filename);
}

module.exports = function ModuleLoader(runspace, options) {
    function Module(id, parent) {
        this.id = id;
        this.exports = {};
        this.parent = parent;
        if (parent && parent.children) {
            parent.children.push(this);
        }
        this.filename = null;
        this.loaded = false;
        this.children = [];
    }
    Module.Module = Module;
    Module.cache = {};
    Module.extensions = {
        '.js': function (module, filename) {
            loadScript(runspace, module, filename);
        },
        '.json': function (module, filename) {
            loadJSON(runspace, module, filename);
        },
        '.node': function (module, filename) {
            loadNative(runspace, module, filename);
        }
    };
    this.deny = options.deny || [];
    this.loadPaths = options.loadPaths || [];
    this.pathCache = {};
    this.Module = Module;
    this.requireAt = function (dirname) {
        dirname = path.resolve(dirname);
        if (!runspace.isPathAllowed(dirname)) {
            throwError('', 'dirname must resolve to a path under %s', runspace.scope);
        }
        return requireAt(runspace, this, dirname);
    };
};

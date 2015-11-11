/*jshint node:true,newcap:true,regexp:true */

'use strict';

var EventEmitter = require('events').EventEmitter;
var util = require('util');
var vm = require('vm');
var Map = require('./map');
var WeakMap = require('./weak-map');

var reBeforeDot = /^.*(\.|#)/;
var noop = function () {};
var namedFnGen = Object.create(null);
var internalAccess;

var KEYWORDS = 'break case class catch const continue debugger default delete do else export extends false finally for function if import in instanceof let new null return super switch this throw true try typeof undefined var void while with yield'.split(' ');
var DONT_PROXY = vm.runInNewContext('Object.getOwnPropertyNames(this)').filter(function (v) {
    return v.charAt(0).toLowerCase() !== v.charAt(0) && typeof global[v] === 'function' && v !== 'Object';
}).map(function (v) {
    return global[v];
});
DONT_PROXY.push(Buffer, ArrayBuffer, Int8Array, Int16Array, Int32Array, Uint8Array, Uint8ClampedArray, Uint16Array, Uint32Array, Float64Array);

var undef = Object.freeze({
    wrap: function (v) {
        return v === undefined ? undef : v;
    },
    unwrap: function (v) {
        return v === undef ? undefined : v;
    }
});

function slice() {
    var length = arguments.length;
    var arr = new Array(length);
    for (var i = 0; i < length; i++) {
        arr[i] = arguments[i];
    }
    return arr;
}

function hasOwnProperty(obj, prop) {
    // If obj.hasOwnProperty has been overridden, then calling
    // obj.hasOwnProperty(prop) will break.
    // See: https://github.com/joyent/node/issues/1707
    return Object.prototype.hasOwnProperty.call(obj, prop);
}

function dontProxy(obj) {
    if (typeof obj === 'function') {
        return obj === Object || DONT_PROXY.indexOf(obj) >= 0;
    }
    return DONT_PROXY.some(function (v) {
        return obj instanceof v;
    });
}

function exposeGlobals(context) {
    var natives = vm.runInContext('var o = Object.create(null), self = this; Object.getOwnPropertyNames(self).forEach(function (i) { o[i] = self[i] }), o', context);
    for (var i in natives) {
        context[i] = natives[i];
    }
}

function translateNativeObject(obj, src, dst) {
    if (!src.isNaN) {
        exposeGlobals(src);
    }
    if (!dst.isNaN) {
        exposeGlobals(dst);
    }
    if (obj instanceof src.Date) {
        return new dst.Date(+obj);
    }
    if (obj instanceof src.Error) {
        var err = (dst[obj.constructor.name] || dst.Error)();
        var keys = Object.getOwnPropertyNames(obj);
        for (var i = 0, length = keys.length; i < length; i++) {
            err[keys[i]] = obj[keys[i]];
        }
        return err;
    }
    if (obj instanceof src.RegExp) {
        return new dst.RegExp(obj.source, (obj.global ? 'g' : '') + (obj.ignoreCase ? 'i' : '') + (obj.multiline ? 'm' : ''));
    }
    if (typeof obj === 'function') {
        if (src[obj.name] && dst[obj.name]) {
            return dst[obj.name];
        }
    }
}

function throwEAcces(target, prop, message) {
    var name = ((target !== null && target !== undefined && target.constructor.name) || '').replace(/(.)$/, '$1.') + prop;
    var err = new Error(util.format(message, name));
    err.code = 'EACCES';
    throw err;
}

function defineConstructor(obj, constructor) {
    Object.defineProperty(obj, 'constructor', {
        value: constructor,
        writable: true,
        configurable: true
    });
}

function createNamedFunction(name, fn, errFn) {
    /* jshint -W054 */
    name = String(name || '').replace(/([^a-zA-Z0-9_$])+/g, '_');
    if (KEYWORDS.indexOf(name) >= 0) {
        name = '__' + name;
    }
    if (!namedFnGen[name]) {
        namedFnGen[name] = new Function('fn, errFn', 'return function ' + name + '() { try { return fn.apply(this, arguments); } catch (ex) { throw errFn(ex) || ex; } }');
    }
    return namedFnGen[name](fn || noop, errFn || noop);
}

function createNamedObject(name, prototype) {
    var obj = Object.create(prototype || Object.prototype);
    defineConstructor(obj, createNamedFunction(name));
    return obj;
}

function createCtorApply(ctor) {
    return function () {
        var obj = Object.create(ctor.prototype);
        ctor.apply(obj, arguments);
        return obj;
    };
}

function createProxy(host, target, options, map) {
    options = options || {};

    function wrapObject(obj) {
        if (obj && (typeof obj === 'object' || typeof obj === 'function')) {
            var proxy = host.getProxy(obj);
            if (proxy) {
                return proxy;
            }
            var CtorProxy = host.getProxy(obj.constructor);
            if (CtorProxy) {
                return new CtorProxy(obj);
            }
            if (host.context) {
                return translateNativeObject(obj, global, host.context) || obj;
            }
        }
        return obj;
    }

    function unwrapObject(obj) {
        if (obj && (typeof obj === 'object' || typeof obj === 'function')) {
            if (hasOwnProperty(obj, '__proxyTarget__')) {
                try {
                    internalAccess = true;
                    return obj.__proxyTarget__;
                } finally {
                    internalAccess = false;
                }
            }
            if (host.context) {
                return translateNativeObject(obj, host.context, global) || obj;
            }
        }
        return obj;
    }

    function freezeObject(obj, map) {
        if (obj && typeof obj === 'object') {
            // objects that are already proxied or can be handled by existing proxies
            // are handled by the proxy and will not be freezed
            if (wrapObject(obj) === obj) {
                if (Array.isArray(obj)) {
                    map.set(obj, Object.freeze(obj.map(function (v) {
                        return freezeObject(v, map);
                    })));
                } else if (!dontProxy(obj)) {
                    Object.preventExtensions(createProxy(host, obj, {
                        freeze: true
                    }, map));
                }
            }
            return host.getProxy(obj) || obj;
        }
        return obj;
    }

    function createAssertion(prop, message) {
        if ((Array.isArray(options.deny) && options.deny.indexOf(prop) >= 0) ||
            (Array.isArray(options.allow) && options.allow.indexOf(prop) < 0)) {
            return function () {
                throwEAcces(this, prop, message);
            };
        }
        return function () {};
    }

    function createObject(obj, name, map, ns) {
        var proto = Object.getPrototypeOf(obj);
        if (proto && !dontProxy(proto.constructor)) {
            var CtorProxy = host.getProxy(proto.constructor) || createCtorFunction(proto.constructor);
            if (proto.constructor.prototype !== proto) {
                // this prototype object is not new'd and assigned to the constructor
                // but is the original prototype object with __proto__ modified
                proto = createObject(proto, proto.constructor.name, map);
                defineConstructor(proto, CtorProxy);
            } else if (proto instanceof proto.constructor) {
                proto = new CtorProxy(proto, map);
            } else {
                proto = CtorProxy.prototype;
            }
        }
        var proxy = createNamedObject(name, proto);
        defineProperties(proxy, obj, map, ns);
        return proxy;
    }

    function createCtorFunction(ctor, name, map) {
        name = ctor.name || name || '';
        if (dontProxy(ctor)) {
            throw new TypeError('Constructor \'' + name + '\' cannot be proxied');
        }
        var ctorApply = createCtorApply(ctor);
        var CtorProxy = createNamedFunction(name, function () {
            host.throwIfTerminated();
            var target, map;
            if (!arguments.length || !(arguments[0] instanceof ctor)) {
                // called from sandbox with arguments
                // call original constructor to create new instance
                // sandbox created instance must be weak-referenced
                var args = slice.apply(null, arguments);
                if (options.new) {
                    var value = options.new(name, ctorApply, args, undef, undef);
                    if (value !== undefined) {
                        return wrapObject(undef.unwrap(value));
                    }
                }
                target = ctorApply.apply(null, args);
            } else {
                // called internally with existing instance outside
                // second parameter is the preferred map if supplied
                target = arguments[0];
                map = arguments.length > 1 && arguments[1];
            }
            defineProperties(this, target, map, name + '#');
        }, wrapObject);
        CtorProxy.prototype = createObject(ctor.prototype, name, map || host._permMap, name + '#');
        defineConstructor(CtorProxy.prototype, CtorProxy);
        defineProperties(CtorProxy, ctor, map || host._permMap, name + '.');
        return CtorProxy;
    }

    function createFunction(name, fn, argsIn, argsOut) {
        name = name || fn.name;
        var prop = name.replace(reBeforeDot, '');
        var assert = createAssertion(name, 'Function call to %s() is blocked');
        return createNamedFunction(prop, function () {
            host.throwIfTerminated();
            assert();
            var context = argsIn(this);
            var args = slice.apply(null, arguments).map(function (v) {
                v = argsIn(v);
                if (typeof v === 'function') {
                    return createNamedFunction(v.name, function () {
                        host.throwIfTerminated();
                        var context = argsOut(this);
                        var args = slice.apply(null, arguments).map(argsOut);
                        return argsIn(v.apply(context, args));
                    }, argsIn);
                }
                return v;
            });
            if (options.call) {
                var value = options.call(name, fn, args, context, undef);
                if (value !== undefined) {
                    return argsOut(undef.unwrap(value));
                }
            }
            return argsOut(fn.apply(context, args));
        }, argsOut);
    }

    function createInFunction(name, fn) {
        return createFunction(name, fn, unwrapObject, wrapObject);
    }

    function createOutFunction(name, fn) {
        return createFunction(name, fn, wrapObject, unwrapObject);
    }

    function createGetter(name, obj, map) {
        var prop = name.replace(reBeforeDot, '');
        var assert = createAssertion(name, 'Access to property %s is blocked');
        var freeze = options.freeze === true || (Array.isArray(options.freeze) && options.freeze.indexOf(name) >= 0);
        return createNamedFunction(prop, function () {
            host.throwIfTerminated();
            assert();
            var value = obj[prop];
            if (options.get) {
                var nvalue = options.get(name, value, obj, undef);
                if (nvalue !== undefined) {
                    value = undef.unwrap(nvalue);
                }
            }
            if (freeze) {
                return freezeObject(value, map);
            }
            return wrapObject(value);
        }, wrapObject);
    }

    function createSetter(name, obj, map) {
        var prop = name.replace(reBeforeDot, '');
        var assert = createAssertion(name, 'Access to property %s is blocked');
        var freeze = options.freeze === true || (Array.isArray(options.freeze) && options.freeze.indexOf(name) >= 0);
        return createNamedFunction(prop, function (value) {
            host.throwIfTerminated();
            assert();
            if (!freeze) {
                value = unwrapObject(value);
                if (options.set) {
                    var nvalue = options.set(name, value, obj, undef);
                    if (nvalue !== undefined) {
                        obj[prop] = undef.unwrap(nvalue);
                        return;
                    }
                }
                obj[prop] = value;
            }
        }, wrapObject);
    }

    function defineProperty(proxy, target, prop, descriptor, map, ns) {
        var nsprop = (ns || '') + prop;
        if (prop.charAt(0).toLowerCase() !== prop.charAt(0) && typeof target[prop] === 'function') {
            // assume function from a captialized property is a constructor
            // but do not process the same constructor again
            Object.defineProperty(proxy, prop, {
                value: host.getProxy(target[prop]) || createCtorFunction(target[prop], prop),
                writable: descriptor.writable,
                enumerable: descriptor.enumerable
            });
        } else if (descriptor.get || descriptor.set) {
            Object.defineProperty(proxy, prop, {
                get: descriptor.get && createGetter(nsprop, target, map),
                set: descriptor.set && createSetter(nsprop, target, map),
                enumerable: descriptor.enumerable
            });
        } else if (descriptor.writable) {
            var getter = createGetter(nsprop, target, map);
            var setter = createSetter(nsprop, target, map);
            Object.defineProperty(proxy, prop, {
                get: function () {
                    var value = target[prop];
                    if (typeof value === 'function') {
                        if (!map.has(value)) {
                            map.set(value, createInFunction(nsprop, value));
                        }
                        return map.get(value);
                    }
                    return getter();
                },
                set: function (value) {
                    if (this !== proxy) {
                        // set value as an own property which has already been
                        // defined on its prototype chain
                        if (this !== unwrapObject(this)) {
                            var map = host.isWeaklyProxied(unwrapObject(this)) ? host._tempMap : host._permMap;
                            defineProperty(this, unwrapObject(this), prop, descriptor, map, ns);
                            this[prop] = value;
                        } else {
                            Object.defineProperty(this, prop, {
                                value: value,
                                writable: true,
                                enumerable: descriptor.enumerable,
                                configurable: true
                            });
                        }
                        return;
                    }
                    if (typeof target[prop] === 'function') {
                        throwEAcces(this, prop, 'Writing to property %s is blocked');
                    }
                    setter(value);
                },
                enumerable: descriptor.enumerable
            });
        } else if (typeof target[prop] === 'function') {
            Object.defineProperty(proxy, prop, {
                value: createInFunction(nsprop, target[prop]),
                enumerable: descriptor.enumerable
            });
        } else {
            Object.defineProperty(proxy, prop, {
                get: createGetter(nsprop, target, map),
                enumerable: descriptor.enumerable
            });
        }
    }

    function defineProperties(proxy, target, map, ns) {
        map = map || host._tempMap;
        map.set(target, proxy);
        Object.defineProperty(proxy, '__proxyTarget__', {
            get: function () {
                if (internalAccess) {
                    return target;
                }
            }
        });
        Object.getOwnPropertyNames(target).forEach(function (prop) {
            if ((prop === '__proto__' || prop === 'constructor' || prop.substr(0, 9) === '$weakMap$') ||
                (Object.getOwnPropertyDescriptor(proxy, prop) || {}).configurable === false) {
                return;
            }
            var descriptor = Object.getOwnPropertyDescriptor(target, prop);
            if (!descriptor) {
                // WTF the descriptor can be undefined!
                // yes we encountered in process.env on Node.js 0.10 win32
                descriptor = {
                    value: target[prop],
                    writable: true,
                    enumerable: true,
                    configurable: true
                };
            }
            defineProperty(proxy, target, prop, descriptor, map, ns);
        });
    }

    if (typeof target === 'function') {
        if (options.functionType === 'ctor' || target.name.charAt(0).toLowerCase() !== target.name.charAt(0)) {
            return createCtorFunction(target, options.name, map);
        }
        if (options.functionType === 'out') {
            return createOutFunction(options.name, target);
        }
        return createInFunction(options.name, target);
    }
    if (typeof target === 'object') {
        if (dontProxy(target)) {
            throw new TypeError('Object of \'' + target.constructor.name + '\' cannot be proxied');
        }
        return createObject(target, options.name, map);
    }
    throw new TypeError('Primitive value cannot be proxied');
}

function Proxy() {
    EventEmitter.call(this);
    this._permMap = new Map();
    this._tempMap = new WeakMap();
}
util.inherits(Proxy, EventEmitter);

Proxy.prototype.proxy = function (obj, options) {
    return this.getProxy(obj) || createProxy(this, obj, options);
};
Proxy.prototype.weakProxy = function (obj, options) {
    return this.getProxy(obj) || createProxy(this, obj, options, this._tempMap);
};
Proxy.prototype.add = function (obj, options) {
    return this.getProxy(obj) || createProxy(this, obj, options, this._permMap);
};
Proxy.prototype.isWeaklyProxied = function (obj) {
    return this._tempMap.has(obj);
};
Proxy.prototype.getProxy = function (obj) {
    return this._permMap.get(obj) || this._tempMap.get(obj);
};
Proxy.prototype.throwIfTerminated = function () {
    if (this.terminated) {
        throw new Error('proxy terminated');
    }
};
Proxy.prototype.terminate = function () {
    Object.defineProperty(this, 'terminated', {
        value: true
    });
    this._permMap.clear();
    this._tempMap = new WeakMap();
    this.emit('terminate');
};

module.exports = Proxy;

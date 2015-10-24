/*jshint node:true,newcap:true,regexp:true */

'use strict';

var EventEmitter = require('events').EventEmitter;
var util = require('util');
var Map = require('./map');
var WeakMap = require('./weak-map');

var slice = Array.prototype.slice;
var reBeforeDot = /^.*(\.|#)/;
var namedFnGen = {};
var internalAccess;

var undef = Object.freeze({
    wrap: function (v) {
        return v === undefined ? undef : v;
    },
    unwrap: function (v) {
        return v === undef ? undefined : v;
    }
});

function returnThis() {
    /*jshint -W040 */
    return this;
}

function hasOwnProperty(obj, prop) {
    // If obj.hasOwnProperty has been overridden, then calling
    // obj.hasOwnProperty(prop) will break.
    // See: https://github.com/joyent/node/issues/1707
    return Object.prototype.hasOwnProperty.call(obj, prop);
}

function throwError(target, prop, message) {
    var name = ((target !== null && target !== undefined && target.constructor.name) || '').replace(/(.)$/, '$1.') + prop;
    var err = new Error(util.format(message || 'Access to property %s is blocked', name));
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

function createNamedFunction(name, fn) {
    /* jshint -W054 */
    if (!name) {
        return fn || function () {};
    }
    if (!namedFnGen[name]) {
        namedFnGen[name] = new Function('fn', 'return function ' + (name || '') + '() { return fn.apply(this, arguments); }');
    }
    return namedFnGen[name](fn || returnThis);
}

function createNamedObject(name, prototype) {
    var obj = Object.create(prototype || Object.prototype);
    defineConstructor(obj, createNamedFunction(name));
    return obj;
}

function createProxy(host, target, options, map) {
    var tempMap = host._tempMap;
    var permMap = host._permMap;
    options = options || {};

    function wrapObject(obj) {
        if (obj && typeof obj === 'object') {
            return permMap.get(obj) || tempMap.get(obj) || (permMap.has(obj.constructor) && new(permMap.get(obj.constructor))(obj)) || obj;
        }
        return obj;
    }

    function unwrapObject(obj) {
        if (obj && typeof obj === 'object' && hasOwnProperty(obj, '__proxyTarget__')) {
            try {
                internalAccess = true;
                return obj.__proxyTarget__;
            } finally {
                internalAccess = false;
            }
        }
        return obj;
    }

    function createAssertion(prop, message) {
        if ((Array.isArray(options.deny) && options.deny.indexOf(prop) >= 0) ||
            (Array.isArray(options.allow) && options.allow.indexOf(prop) < 0)) {
            return function () {
                throwError(this, prop, message);
            };
        }
        return function () {};
    }

    function createPrototypedObject(obj, name, map) {
        var proto = Object.getPrototypeOf(obj);
        if (proto && proto.constructor !== Object) {
            if (proto.constructor.prototype === proto) {
                var CtorProxy = permMap.get(proto.constructor) || createCtorFunction(proto.constructor);
                if (proto instanceof proto.constructor) {
                    return new CtorProxy(proto, map);
                }
                return createNamedObject(name, CtorProxy.prototype);
            }
            return createPrototypedObject(proto, proto.constructor.name, map);
        }
        return createNamedObject(name);
    }

    function createCtorFunction(ctor, name, map) {
        name = ctor.name || name;
        var CtorProxy = createNamedFunction(name, function (obj, map) {
            host.throwIfTerminated();
            if (!(obj instanceof ctor)) {
                // constructor directly called by user space
                // called the original constructor and wrap with our proxy constructor
                var target = Object.create(ctor.prototype);
                ctor.apply(target, arguments);
                return new CtorProxy(target);
            }
            defineProperties(this, obj, map, name + '#');
            return this;
        });
        defineProperties(CtorProxy, ctor, map || permMap, name + '.');

        // setting up prototype of the constructor
        CtorProxy.prototype = createPrototypedObject(ctor.prototype, name, map || permMap);
        defineConstructor(CtorProxy.prototype, CtorProxy);
        defineProperties(CtorProxy.prototype, ctor.prototype, map || permMap, name + '#');
        return CtorProxy;
    }

    function createFunction(name, fn, argsIn, argsOut) {
        var prop = name.replace(reBeforeDot, '');
        var assert = createAssertion(name, 'Function call to %s() is blocked');
        return createNamedFunction(prop, function () {
            host.throwIfTerminated();
            assert();
            var context = argsIn(this);
            var args = slice.call(arguments).map(function (v) {
                v = argsIn(v);
                if (typeof v === 'function') {
                    return function () {
                        var context = argsOut(this);
                        var args = slice.call(arguments).map(argsOut);
                        return argsIn(v.apply(context, args));
                    };
                }
                return v;
            });
            if (options.call) {
                var value = options.call(name, args, context, undef);
                if (value !== undefined) {
                    return argsOut(undef.unwrap(value));
                }
            }
            return argsOut(fn.apply(context, args));
        });
    }

    function createInFunction(name, fn) {
        return createFunction(name, fn, unwrapObject, wrapObject);
    }

    function createOutFunction(name, fn) {
        return createFunction(name, fn, wrapObject, unwrapObject);
    }

    function createGetter(name, obj) {
        var prop = name.replace(reBeforeDot, '');
        var assert = createAssertion(name);
        return function () {
            host.throwIfTerminated();
            assert();
            if (options.get) {
                var value = options.get(name, obj, undef);
                if (value !== undefined) {
                    return wrapObject(undef.unwrap(value));
                }
            }
            return wrapObject(obj[prop]);
        };
    }

    function createSetter(name, obj) {
        var prop = name.replace(reBeforeDot, '');
        var assert = createAssertion(name);
        return function (value) {
            host.throwIfTerminated();
            assert();
            value = unwrapObject(value);
            if (options.set) {
                var nvalue = options.set(name, value, obj, undef);
                if (nvalue !== undefined) {
                    obj[prop] = undef.unwrap(nvalue);
                    return;
                }
            }
            obj[prop] = value;
        };
    }

    function defineProperties(proxy, target, map, ns) {
        (map || tempMap).set(target, proxy);
        Object.defineProperty(proxy, '__proxyTarget__', {
            get: function () {
                if (internalAccess) {
                    return target;
                }
            }
        });
        Object.getOwnPropertyNames(target).forEach(function (prop) {
            if (prop === '__proto__' || prop === 'constructor' || (Object.getOwnPropertyDescriptor(proxy, prop) || {}).configurable === false) {
                return;
            }

            var descriptor = Object.getOwnPropertyDescriptor(target, prop);
            var nsprop = (ns || '') + prop;

            if (prop.charAt(0).toLowerCase() !== prop.charAt(0) && typeof target[prop] === 'function') {
                // assume function from a captialized property is a constructor
                // but do not process the same constructor again
                Object.defineProperty(proxy, prop, {
                    value: permMap.get(target[prop]) || createCtorFunction(target[prop], prop),
                    writable: true,
                    configurable: descriptor.configurable,
                    enumerable: descriptor.enumerable
                });
            } else if (descriptor.get || descriptor.set) {
                Object.defineProperty(proxy, prop, {
                    get: descriptor.get && createGetter(nsprop, target),
                    set: descriptor.set && createSetter(nsprop, target),
                    configurable: descriptor.configurable,
                    enumerable: descriptor.enumerable
                });
            } else if (descriptor.writable) {
                var getter = createGetter(nsprop, target);
                var setter = createSetter(nsprop, target);
                Object.defineProperty(proxy, prop, {
                    get: function () {
                        var value = target[prop];
                        if (typeof value === 'function') {
                            if (!permMap.has(value)) {
                                permMap.set(value, createInFunction(nsprop, value));
                            }
                            return permMap.get(value);
                        }
                        return getter();
                    },
                    set: function (value) {
                        if (this !== proxy && !hasOwnProperty(this, prop)) {
                            Object.defineProperty(this, prop, {
                                value: value,
                                writable: true,
                                configurable: descriptor.configurable,
                                enumerable: descriptor.enumerable
                            });
                            return;
                        }
                        if (typeof target[prop] === 'function') {
                            throwError(this, prop, 'Writing to property %s is blocked');
                        }
                        setter(value);
                    },
                    configurable: descriptor.configurable,
                    enumerable: descriptor.enumerable
                });
            } else if (typeof target[prop] === 'function') {
                Object.defineProperty(proxy, prop, {
                    value: createInFunction(nsprop, target[prop]),
                    configurable: descriptor.configurable,
                    enumerable: descriptor.enumerable
                });
            } else {
                Object.defineProperty(proxy, prop, {
                    get: createGetter(nsprop, target),
                    configurable: descriptor.configurable,
                    enumerable: descriptor.enumerable
                });
            }
        });
    }

    if (typeof target === 'function') {
        if (options.functionType === 'ctor' || target.name.charAt(0).toLowerCase() !== target.name.charAt(0)) {
            return createCtorFunction(target, options.name, map);
        }
        if (options.functionType === 'out') {
            return createOutFunction(options.name || target.name, target);
        }
        return createInFunction(options.name || target.name, target);
    }
    var proxy = createPrototypedObject(target, options.name, map);
    defineProperties(proxy, target, map);
    return proxy;
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

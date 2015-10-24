/*jshint node:true,newcap:true,regexp:true */
/*globals WeakMap */

// !!! CAUTION ON REFERENCING THIS SOURCE !!!
// naive polyfill of ES6 WeakMap that is good enough for this module
// implementation adopted from https://github.com/medikoo/es6-weak-map
// known incapabilities include:
// do NOT accept non-extensible object as weak map key
// do NOT hide associated values from other scope than that holding the weak map

'use strict';

if (typeof WeakMap === 'function') {
    module.exports = WeakMap;
    return;
}

function randomString() {
    var str;
    do {
        str = Math.random().toString(36).slice(2);
    } while (randomString[str]);
    randomString[str] = str;
    return str;
}

function hasOwnProperty(obj, prop) {
    return Object.prototype.hasOwnProperty.call(obj, prop);
}

function WeakMapPoly() {
    if (!(this instanceof WeakMapPoly)) {
        throw new TypeError('Constructor requires \'new\'');
    }
    Object.defineProperty(this, '__weakMapData__', {
        value: '$weakMap$' + randomString()
    });
    return this;
}

WeakMapPoly.prototype.delete = function (key) {
    if (hasOwnProperty(key, this.__weakMapData__)) {
        delete key[this.__weakMapData__];
        return true;
    }
    return false;
};
WeakMapPoly.prototype.get = function (key) {
    if (hasOwnProperty(key, this.__weakMapData__)) {
        return key[this.__weakMapData__];
    }
};
WeakMapPoly.prototype.has = function (key) {
    return hasOwnProperty(key, this.__weakMapData__);
};
WeakMapPoly.prototype.set = function (key, value) {
    if ((typeof key !== 'object' && typeof key !== 'function') || !key) {
        throw new TypeError('Invalid value used as weak map key');
    }
    if (Object.isFrozen(key) || !Object.isExtensible(key) || Object.isSealed(key)) {
        throw new Error('Unable to polyfill for sealed, frozen or non-extensible object as weak map key');
    }
    Object.defineProperty(key, this.__weakMapData__, {
        value: value,
        configurable: true
    });
    return this;
};
WeakMapPoly.prototype.toString = function () {
    return '[object WeakMap]';
};

module.exports = WeakMapPoly;

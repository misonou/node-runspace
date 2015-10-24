/*jshint node:true,newcap:true,regexp:true */
/*globals Map */

// !!! CAUTION ON REFERENCING THIS SOURCE !!!
// native polyfill of ES6 Map that is good enough for this module
// known incapabilities include:
// do NOT work when NaN supplied as key
// O(n) efficiency instead of sublinear

'use strict';

if (typeof Map === 'function') {
    module.exports = Map;
    return;
}

function iterator(m, callback) {
    var i = 0;
    var keys = m.__mapKeysData__.slice(0);
    var values = m.__mapValuesData__.slice(0);
    var length = keys.length;
    return {
        next: function () {
            if (i < length) {
                return {
                    value: callback(keys, values, i++),
                    done: false
                };
            }
            return {
                done: true
            };
        }
    };
}

function MapPoly() {
    if (!(this instanceof MapPoly)) {
        throw new TypeError('Constructor requires \'new\'');
    }
    Object.defineProperties(this, {
        __mapKeysData__: {
            value: [],
            configurable: true
        },
        __mapValuesData__: {
            value: [],
            configurable: true
        }
    });
}

MapPoly.prototype.clear = function () {
    this.__mapKeysData__.splice(0, this.__mapKeysData__.length);
    this.__mapValuesData__.splice(0, this.__mapValuesData__.length);
};
MapPoly.prototype.delete = function (key) {
    var index = this.__mapKeysData__.indexOf(key);
    if (index === -1) {
        return false;
    }
    this.__mapKeysData__.splice(index, 1);
    this.__mapValuesData__.splice(index, 1);
    return true;
};
MapPoly.prototype.entries = function () {
    return iterator(this, function (k, v, i) {
        return [k[i], v[i]];
    });
};
MapPoly.prototype.forEach = function (cb, thisArg) {
    var iterator = this.entries();
    var result = iterator.next();
    while (!result.done) {
        cb.call(thisArg, result.value[1], result.value[0], this);
        result = iterator.next();
    }
};
MapPoly.prototype.get = function (key) {
    var index = this.__mapKeysData__.indexOf(key);
    if (index >= 0) {
        return this.__mapValuesData__[index];
    }
};
MapPoly.prototype.has = function (key) {
    return (this.__mapKeysData__.indexOf(key) !== -1);
};
MapPoly.prototype.keys = function () {
    return iterator(this, function (k, v, i) {
        return k[i];
    });
};
MapPoly.prototype.set = function (key, value) {
    var index = this.__mapKeysData__.indexOf(key);
    if (index === -1) {
        index = this.__mapKeysData__.push(key) - 1;
    }
    this.__mapValuesData__[index] = value;
    return this;
};
Object.defineProperty(MapPoly.prototype, 'size', {
    get: function () {
        return this.__mapKeysData__.length;
    }
});
MapPoly.prototype.values = function () {
    return iterator(this, function (k, v, i) {
        return v[i];
    });
};
MapPoly.prototype.toString = function () {
    return '[object Map]';
};

module.exports = MapPoly;

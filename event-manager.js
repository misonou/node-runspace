/*jshint node:true */

'use strict';

var Map = require('./map');

function EventManager() {
    this.emitters = new Map();
}

EventManager.prototype.getListeners = function (emitter, eventType) {
    var listeners = this.emitters.get(emitter);
    if (!listeners) {
        listeners = Object.create(null);
        this.emitters.set(emitter, listeners);
    }
    if (!listeners[eventType]) {
        listeners[eventType] = [];
    }
    return listeners[eventType];
};
EventManager.prototype.addListener = function (emitter, eventType, listener, once) {
    var self = this;
    var listenerProxy;
    if (eventType === 'newListener' || eventType === 'removeListener') {
        listenerProxy = function () {
            if (self.emitters.has(this)) {
                if (once) {
                    self.removeListener(emitter, eventType, listener);
                }
                listener.apply(this, arguments);
            }
        };
    } else if (once) {
        listenerProxy = function () {
            self.removeListener(emitter, eventType, listener);
            listener.apply(this, arguments);
        };
    }
    var arr = self.getListeners(emitter, eventType);
    arr.push({
        listener: listener,
        listenerProxy: listenerProxy || listener
    });
    emitter.addListener(eventType, listenerProxy || listener);
};
EventManager.prototype.removeListener = function (target, eventType, listener) {
    var arr = this.getListeners(target, eventType);
    for (var i = 0, length = arr.length; i < length; i++) {
        if (arr[i].listener === listener) {
            target.removeListener(eventType, arr[i].listenerProxy);
            arr.splice(i, 1);
            return;
        }
    }
};
EventManager.prototype.removeAllListeners = function (emitter, eventType) {
    var self = this;
    if (!emitter) {
        return self.emitters.forEach(function (v, target) {
            self.removeAllListeners(target);
        });
    }
    var listeners = self.emitters.get(emitter);
    if (listeners) {
        self.emitters.delete(emitter);
        Object.getOwnPropertyNames(listeners).forEach(function (i) {
            if (!eventType || i === eventType) {
                listeners[i].splice(0).forEach(function (v) {
                    emitter.removeListener(i, v.listenerProxy);
                });
            }
        });
    }
};

module.exports = EventManager;

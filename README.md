# Runspace

Creates a sandbox for running untrusted code.

## Installation

`npm install runspace`

## Usage

### Runspace(path, [options])

Creates a sandbox for running untrusted code that is rooted at the given path.
Files and modules outside the given path are normally denied for access.

See [Sandbox](#sandbox) section for more details.

```javascript
var runspace = new Runspace('./sandbox');
var script = runspace.compileScript('return number + 1;', './sandbox/add.js');
script.run({ number: 1 }); // 2
```

#### Options

Below is an exhausive list of options, with the default value shown.

```javascript
{
    // list of modules outside allowed sandbox's root path
    allow: [],

    // list of built-in modules which access shall be denied
    deny: []
}
```

### runspace.compileScript(code, filename)

The second argument `filename` is required but need not to be an existed one.
It will be the working path for resolving module locations.

```javascript
var runspace = new Runspace('/parent/sandbox');
var script = runspace.compileScript('require("dependency")', '/parent/sandbox/b/hello-world.js');

// look for:
// /parent/sandbox/b/dependency
// /parent/sandbox/b/dependency.{js,json,node}
// /parent/sandbox/b/dependency/index.{js,json,node}
// /parent/sandbox/b/node_modules/dependency
// /parent/sandbox/node_modules/dependency
// but NOT:
// /parent/node_modules/dependency, /node_modules/dependency
script.run();

// throws exception
runspace.compileScript('console.log()', '/outside-sandbox/example.js');
```

#### Passing additional globals

Another than default available globals (See [Global](#global)),
additional global variables can be passed to the compiled script.

```javascript
var script = runspace.compileScript('return number + 1;', './sandbox/add.js');
script.run({ number: 1 }); // 2
```

### runspace.terminate()

A runspace can be terminated by calling `terminate()`.

### Event: message

Triggered when `process.send()` is called inside sandbox.

### Event: terminate

Triggered when `runspace.terminate()` is called.

## Proxy

Proxies are wrappers on objects that allow protection
and interception when those objects are accessed by untrusted code.

> **Important:** Due to limitation in ES5, the proxies generated by this
  library is not intended to be a polyfill solution, with the following limitation:
  - Properties are converted to get/setters on proxies to provide interception;
  - Properties and methods on an object are only available on its proxy when they exist during proxy creation.
    Afterwards new properties and methods cannot be accessed through the proxy.

### Functions and callbacks

Functions and callbacks are handled such that arguments and return values are
translated from objects to their proxy counterparts and vice versa.

```javascript
function ClassA() {}
function ClassB() {}
function ClassX() {}
var objAdded = {};

runspace.add(new ClassA());
runspace.add(ClassB);
runspace.add(objAdded);

var instA = new ClassA();
var returnedInstA = script.run({
    ClassA: ClassA,
    ClassB: ClassB,
    ClassX: ClassX,
    instA: instA,
    instB: new ClassB(),
    instC: new ClassX(),
    objNotAdded: {},
    func: function (argInstA) {
        // arguments are un-proxied
        argInstA === instA; // true
        return instA;
    }
});
// returned value is un-proxied
returnedInstA === instA; // true

// sandbox
// proxied
ClassA, ClassB, instA, instB, objAdded;
ClassA.prototype, Object.getPrototypeOf(instB), instB.__proto__;

// NOT proxied
ClassX, instC, objNotAdded;

// proxied instA is un-proxied when passed to callbacks
// and returned instA is re-proxied
var returnedInstA = func(instA);
returnedInstA === instA;

// proxied instA is un-proxied when returned
return instA;
```

### runspace.getProxy(target)

Gets the proxy if the target has been proxied. Otherwise `undefined` is returned.

### runspace.add/proxy/weakProxy(target, [options])

Objects are proxied in two flavors:

-   **Weakly-referenced** proxies are for temporal objects that lived within
    the life of sandbox. The references being weak allows GC to collect even though the sandbox is active.


-   **Strongly-referenced** proxies are for global and shared objects.
    The references being strong allows `Runspace` to clear resources when terminating.

The target's prototypes are **implicitly** proxied recursively, i.e. all prototype objects and constructors up
the prototype chain have also their proxy counterparts.

**Differences on add/proxy/weakProxy: **

<table>
    <tr>
        <td></td>
        <td>`add`</td>
        <td>`proxy`</td>
        <td>`weakProxy`</td>
    </tr>
    <tr>
        <td>`target`</td>
        <td>Strong</td>
        <td>Weak</td>
        <td>Weak</td>
    </tr>
    <tr>
        <td>`target.constructor`<br>`target.__proto__`<br>(recursively) </td>
        <td>Strong</td>
        <td>Strong</td>
        <td>Weak</td>
    </tr>
</table>

> **Important:** Calling the proxy generating methods for the same target repeatedly
  returns the same already-generated proxy instead of a new one; and
  the flavor of the proxy (strong-/weak-referenced) also remains unchanged.

#### Options

Below is an exhausive list of options. All options are **optional**.

```javascript
{
    // when target is [Function]
    // name to assign for anonymous function
    name: '',

    // when target is [Function]
    // accepted values: 'in', 'out', 'ctor'
    // specify whether the function:
    // in: accepts arguments from and returns value to sandbox
    // out: accepts arguments from and returns value to outside sandbox
    // ctor: is a constructor (prototype chain is also proxied)
    // default -
    //    if function name starts with an Uppercased letter: 'ctor'
    //    otherwise: 'in'
    functionType: '',

    // whitelist of properties and methods allowed to access
    // see notes below
    allow: [],

    // blacklist of properties and methods allowed to access
    // see notes below
    deny: [],

    // called when getting property on a proxy
    // see 'Interceptors'
    get: function (name, target, undef) { ... },

    // called when setting property on a proxy
    // see 'Interceptors'
    set: function (name, value, target, undef) { ... },

    // called when calling method on a proxy
    // see 'Interceptors'
    call: function (name, fn, args, target, undef) { ... },

    // called when creating new instance of a proxied class
    // see 'Interceptors'
    new: function (name, fn, args, undef) { ... }
}
```

**Note:** To blacklist/whitelist constructor "static" and "instance" members,
follow patterns of `MyConstructor.staticMember` and `MyConstructor#instMember`.

If blacklist and whitelist are supplied at the same time,
blacklist takes precendence.

### Interceptors

Interceptors enables modifications on supplied arguments and return value.

#### Arguments to interceptors

Referencing argument names of interceptor options shown in above section:

`name`: name of the property or method intercepted

`fn`: intercepted function

`args`: arguments supplied to the intercepted function

`value`: value supplied to the intercepted property/setter

`target`: target object proxied

`undef`: when returned from interceptors, tell the proxy `undefined` as the return value instead of
proceeding. Arbitrary return value can be wrapped by `undef.wrap()`.

```javascript
undef.wrap(3);                   //3
undef.wrap(null);                // null
undef.wrap(undefined) === undef; // true
```

#### Example: Modifying arguments

```javascript
var target = {
    add: function (a, b) {
        return a + b;
    }
};
runspace.proxy(target, {
    call: function (name, fn, args) {
        if (name === 'add') {
            args[0] = String(args[0]);
        }
    }
});

// sandbox
target.add(1, 2); // '12'
target.add(null, 2); // 'null2'
```

#### Example: Modifying return value

```javascript
var target = {
    one: 1,
    two: 2,
    three: 3,
    four: undefined,
    five: 5
};
runspace.proxy(target, {
    get: function (name, target, undef) {
        switch (name) {
        case 'one':
            return target[name] + '';
        case 'two':
            return undef;
        case 'three':
        case 'four':
            return undef.wrap(function () {
                return name === 'three' ? 3 : undefined;
            }());
        }
        // if reached here, tell the proxy to proceed
        /* return undefined */;
    }
});

// sandbox
target.one;   // '1'
target.two;   // undefined (undefined as return value)
target.three; // 3 (undef.wrap returned as-is)
target.four;  // undefined (undef.wrap wrapped undefined)
target.five;  // 5 (proceed to original property/getter)
```

## Other methods

### runspace.send(message)

Sandboxed code receives the message by `process.on('message')`.
The message can be pritimtive values or object literals.

If object is supplied, the object is sanitized and only primitive valued
properties are sent to the sandbox.

## Sandbox

The following section describes behaviors of globals and built-in modules
inside `Runspace`-created sandbox.

### Global

The `global` object is a contextified sandbox.

Other than default JavaScript globals, globals that are available by Node.js
are also available inside sandbox.

Typed arrays and `Buffer` are shared and **NOT** proxied.

### EventEmitter

Even if the `EventEmitter` object is shared across sandboxes, listeners are scoped
within sandboxes.

#### EventEmitter.listeners([event])

Returns only listeners that are bound by the calling sandbox.

#### EventEmitter.removeAllListeners([event])

Removes only listeners that are bound by the calling sanbox.

### process

The following properties and methods are blocked from access:

`stdin`, `abort`, `binding`, `chdir`, `dlopen`, `exit`, `setgid`, `setegid`, `setuid`, `seteuid`,
`setgroups`, `initgroups`, `kill`, `disconnect`, `mainModule`.

#### process.cwd()

Returns the sandbox root path rather than actual working directory.

#### process.send(message)

The message is routed to `runspace.on('message')` instead of that
the listening process on IPC channel.

#### process.on('message')

Receives message sent from `runspace.send()` instead of from
the listening process on IPC channel.

#### process.on('exit')

The `exit` event is also triggered when the parent `Runspace` object is terminated.

### timers

Handle returned by `setTimeout` and `setInterval` is `unref`'d and cannot be `ref`'d again.
Calling `ref()` throws exception.

### fs

All functions that mention a path other than file descriptor throws exception when
supplied with paths outside the sandbox's scope.

### require

Modules are resolved and required as-is, except:

-   Built-in modules are proxied
-   Built-in modules and their exposed APIs can be denied
-   Modules outside sandbox's root path are invisible unless explicitly allowed
-   Modules are **NOT** shared across sandboxes, i.e. same module required by
    different sandboxes are not of the same instance

## License

The MIT License (MIT)

Copyright (c) 2015 misonou

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
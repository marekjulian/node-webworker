`node-webworkers` is an implementation of the [Web Workers
API](http://www.whatwg.org/specs/web-workers/current-work/) for
[node.js](http://nodejs.org).

See the design document
[here](http://blog.std.in/2010/07/08/nodejs-webworker-design/).

### Updated / Forked Repository

This is a fork of the original implementation which can be found [here](https://github.com/pgriess/node-webworker.git). The forked implementation includes the following modifications and / or enhancements:

  * The code has been upgraded to run on a new version of node such as v0.8.*. This includes:

    * Upgrading to new child_process modulie.
    * The node.js [vm](http://nodejs.org/api/vm.html) module is used to launch node in the worker script in the child process as opposed to the previous script module.

  * Support for websocket protocol version 13 as opposed to the 2 draft protocol versions previously supported.

  * The dependency on websocket-client has been removed. Instead [WebSocket-Node](https://github.com/Worlize/WebSocket-Node.git) is leveraged which supports more recent versions of the websocket protocal. Unfortunately, the auther didn't see a quick easy way to continue to support the extension to piggyback passing of file descriptors.

    * For better or worse, the  [WebSocket-Node](https://github.com/Worlize/WebSocket-Node.git) module has been forked to support connections based upon Unix Domain Sockets.

The motivation for this work was the need to the ability to either spawn a sub-process or thread which would allow work to occur without interferring with the parent processes node event loop. Conceptually, the idea to provide an interface between parent and child processes based upon the WebWorkers protocal, which utilized the WebSocket protocal for transport seemed very attractive. Other implementations, such as [node-webworker-threads](https://github.com/audreyt/node-webworker-threads) were explored. But, those didn't provide as clean and easy to use interface for full-duplex communication between parent and child. Nor, did they provide an easy way to setup a context to run JavaScript under node which was a motivating requirement.

  * In order to provide a cleaner and more reliable delivery of messages which may be sent asynchronously to the child while the connection is being estabilished and webworker handshake is taking place, a new worker to master message has been added: MSGTYPE_CLIENT_READY, which the child sents when the connection is fully estabished and the client is ready to receive messages from the master. The master in turn buffers any messages to be sent to child, and when the MSGTYPE_CLIENT_READY message is received from the client,  those buffered messages are transmitted.

### Example

#### Master source

    var sys = require('sys');
    var Worker = require('webworker');
    
    var w = new Worker('foo.js');
    
    w.onmessage = function(e) {
        sys.debug('Received mesage: ' + sys.inspect(e));
        w.terminate();
    };
    
    w.postMessage({ foo : 'bar' });

#### Worker source

    onmessage = function(e) {
        postMessage({ test : 'this is a test' });
    };
    
    onclose = function() {
        sys.debug('Worker shuttting down.');
    };

### API

Supported API methods are

   * `postMessage(e)` in both workers and the parent; messages are in the
     parent if this is invoked before the child is fully initialized
   * `onmessage(e)` in both workers and the parent
   * `onerror(e)`in both workers and the parent
   * `terminate()` in the parent

In addition, some nonstandard APIs are provided

   * `onclose()` in the worker (allows for graceful shutdown)
   * The `postMessage()` method takes an additional optional file descriptor parameter, which
     will be sent with the message. This descriptor will be passed to
     `onmessage` handlers as an optional `fd` field. Handlers receiving
     messages posted without file descriptors will not see an `fd` field. Both
     the parent and child can send file descriptors using this mechanism.
   * `Worker.onexit(code, signal)` in the master, which is invoked on the
     master `Worker` object when the worker process exits.
   * The `Worker` constructor takes an additional optional object argument,
     `opts`, which is used as a dictionary of options with the following keys
      * `args` : A string or array of strings to pass to the executable before the filename to invoke. This can be used to request that the worker start up in debug mode (e.g. `{ 'args' : '--debug-brk' }`). By default this is empty.
      * `path` : A string naming the executable to invoke for workers. By default this is the value of `process.execPath` (e.g. `node` or similar).

### Installation

This package can be installed via [npm](http://npmjs.org/) as follows

    % npm install webworker

Note that this requires
[node-websocket-client](http://github.com/pgriess/node-websocket-client) v0.9.3
or later. This dependency will be handled automatically by `npm`, but must be
dealt with manually if installing using another procedure.

### Credits

This package contains a static snapshot of Micheil Smith's excellent
[node-websocket-server](http://github.com/miksago/node-websocket-server) with
some fixes applied to handle UNIX sockets.

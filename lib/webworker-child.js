// Launcher script for WebWorkers.
//
// Sets up context and runs a worker script. This is not intended to be
// invoked directly. Rather, it is invoked automatically when constructing a
// new Worker() object.
//
//      usage: node worker.js <sock> <script>
//
//      The <sock> parameter is the filesystem path to a UNIX domain socket
//      that is listening for connections. The <script> parameter is the
//      path to the JavaScript source to be executed as the body of the
//      worker.

var fs = require('fs');
var net = require('net');
var path = require('path');
var sys = require('sys');
var events = require('events');
var _ = require('underscore');
var wwutil = require('./webworker-util');
var vm = require('vm');
var WebSocketServer = require('./ws').WebSocketServer;

wwutil.debug('Webworker child: global keys - ' + _.keys(global));

process.stdout.write('Child about to require WebSocket');

try {
  var WebSocketClient = require('websocket').client;
} catch (e) {
  throw new Error(
    'Worlize/WebSocket-Node must be installed'
  );
}

// Catch exceptions
//
// This implements the Runtime Script Errors section fo the Web Workers API
// specification at
//
//  http://www.whatwg.org/specs/web-workers/current-work/#runtime-script-errors
//
// XXX: There are all sorts of pieces of the error handling spec that are not
//      being done correctly. Pick a clause, any clause.
var inErrorHandler = false;
var exceptionHandler = function(e) {
  if (!inErrorHandler && workerCxt.onerror) {
    inErrorHandler = true;
    workerCxt.onerror(e);
    inErrorHandler = false;

    return;
  }

  // Don't bother setting inErrorHandler here, as we're already delivering
  // the event to the master anyway
  ms.send([wwutil.MSGTYPE_ERROR, {
    'message' : wwutil.getErrorMessage(e),
    'filename' : wwutil.getErrorFilename(e),
    'lineno' : wwutil.getErrorLine(e)
  }]);
};

// Message handling function for messages from the master
var handleMessage = function(msg, fd) {
  if (!wwutil.isValidMessage(msg)) {
    wwutil.debug('Webworker child: Received invalid message: ' + sys.inspect(msg));
    return;
  }

  wwutil.debug('Webworker child: Processing message from parent, msg type - ' + msg[0]);
  switch(msg[0]) {
  case wwutil.MSGTYPE_NOOP:
    break;

  case wwutil.MSGTYPE_CLOSE:
    // Conform to the Web Workers API for termination
    workerCxt.closing = true;

    // Close down the event sources that we know about
    wsConnection.close();

    // Request that the worker perform any application-level shutdown
    if (workerCxt.onclose) {
      workerCxt.onclose();
    }

    if (workerCxt.close) {
      workerCxt.close();
    }

    break;

  case wwutil.MSGTYPE_USER:
    // XXX: I have no idea what the event object here should really look
    //      like. I do know that it needs a 'data' elements, though.
    wwutil.debug('Webworker child: Got message with data - ' + msg[1]);
    if (workerCxt.onmessage) {
      e = { data : msg[1] };

      if (fd) {
        e.fd = fd;
      }

      workerCxt.onmessage(e);
    }
    else {
      wwutil.debug('Webworker child: Child does not have a onmessage handler!');
    }

    break;

  default:
    wwutil.debug('Webworker child: Received unexpected message: ' + sys.inspect(msg));
    break;
  }
};

if (process.argv.length < 4) {
    throw new Error('usage: node worker.js <sock> <script>');
}

var sockPath = process.argv[2];
var scriptLoc = new wwutil.WorkerLocation(process.argv[3]);

// Connect to the parent process
var ws = new WebSocketClient();
var wsConnection = undefined;
var ms = undefined;

var ConnectionProxy = function(connection) {
  var that = this;
  this.connection = connection;
  this.connection.on('message', function(msg) {
    if (msg.type === "utf8") {
      that.emit('message', msg.utf8Data);
    }
  });
};

ConnectionProxy.prototype = Object.create(events.EventEmitter.prototype,
                                          {
                                            write: { 
                                              value: function(msg, fd) {
                                                this.connection.sendUTF(msg);
                                              }
                                            }
                                          }
                                         );

// Once we connect successfully, set up the rest of the world
ws.addListener('connect', function(connection) {
  wwutil.debug('Webworker child: Have connect event...');
  wsConnection = connection;
  var connectionProxy = new ConnectionProxy(connection);
  ms = new wwutil.MsgStream(connectionProxy);
  wwutil.debug('Webworker child: Created message stream');
  //
  // When we receive a message from the master, react and possibly
  // dispatch it to the worker context
  //
  ms.on('msg', handleMessage);

  // Register for uncaught events for delivery to workerCxt.onerror
  process.addListener('uncaughtException', exceptionHandler);

  // Execute the worker
  wwutil.debug('Webworker child: Running script in new context, w/ sandbox - ' + _.keys(workerCxt));
  scriptObj.runInNewContext(workerCxt);

  // Send a message that we are ready to accept messages from the master.
  wwutil.debug('Webworker child: Sending client ready message to master...');
  ms.send([wwutil.MSGTYPE_CLIENT_READY, {}]);
  wwutil.debug('Webworker child: client ready message sent to master!');
});

ws.addListener('connectFailed', function(err) {
  wwutil.debug('Webworker child: Connection failure - ' + err);
});

var wsConnectionPath = 'ws+unix://' + sockPath;

wwutil.debug('Webworker child: Connecting to - ' + wsConnectionPath);
ws.connect(wsConnectionPath);
wwutil.debug('Webworker child: Created web socket for path - ' + sockPath);

// Construt the Script object to host the worker's code
var scriptObj = undefined;
switch (scriptLoc.protocol) {
case 'file':
  wwutil.debug('Webworker child: Creating script obj...');
  scriptObj = vm.createScript(
    fs.readFileSync(scriptLoc.pathname),
    scriptLoc.href
  );
  wwutil.debug('Webworker child: Created script obj...');
  break;

default:
  process.stderr.write('Cannot load script from unknown protocol \'' + 
                       scriptLoc.protocol);
  process.exit(1);
}

//
// Set up the context for the worker instance
//
var workerCxt = _.extend(_.clone(global),
                         {
                           //
                           // Node globals:
                           //
                           process: process,
                           console: console,
                           Buffer: Buffer,
                           require: require,
                           __filename: scriptLoc.pathname,
                           __dirname: path.dirname(scriptLoc.pathname),
                           module: module,
                           exports: exports,
                           setTimeout: setTimeout,
                           clearTimeout: clearTimeout,
                           setInterval: setInterval,
                           clearInterval: clearInterval,
                           //
                           // WebSocket stuff:
                           //
                           wsConnection: wsConnection,
                           ms: ms,
                           postMessage: function(msg, fd) {
                             ms.send([wwutil.MSGTYPE_USER, msg]);
                           },
                           location: scriptLoc,
                           closing: false,
                           close: function() {
                             ms.send([wwutil.MSGTYPE_CLOSE, {}]);
                             process.exit(0);
                           }
                         });

workerCxt.self = workerCxt;
workerCxt.global = workerCxt;

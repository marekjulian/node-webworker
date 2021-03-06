// Utilies and other common gook shared between the WebWorker master and
// its constituent Workers.

var events = require('events');
var path = require('path');
var sys = require('sys');
var urllib = require('url');

// Some debugging functions
var debugLevel = parseInt(process.env.NODE_DEBUG, 16);
var debug = (debugLevel & 0x8) ?
    function() { sys.error.apply(this, arguments); } :
    function() {};
exports.debug = debug;

// Extract meaning from stack traces
var STACK_FRAME_RE = /.* \(?(.+:\d+:\d+)\)?$/;

// Symbolic names for our messages types
exports.MSGTYPE_NOOP = 0;
exports.MSGTYPE_ERROR = 1;
exports.MSGTYPE_CLOSE = 2;
exports.MSGTYPE_USER = 100;
//
// CLIENT_READY: Sent by client to indicate its received the 'connect' event,
//   and is setup to receive messages from the master.
//
exports.MSGTYPE_CLIENT_READY = 101;

// Is the given message well-formed?
var isValidMessage = function(msg) {
    return (Array.isArray(msg) && msg.length == 2);
}
exports.isValidMessage = isValidMessage;

// A simple messaging stream.
//
// This class is constructed around an existing stream net.Stream. This class
// emits 'msg' events when a message is received. Each emitted 'msg' event
// may come with a second 'fd' parameter if the message was sent with  file
// descriptor. A sent file descriptor is guaranteed to be received with the
// message with which it was sent.
//
// Sending messages is done with the send() method.
var MsgStream = function(s) {
  var self = this;

  events.EventEmitter.call(self);

  // Sequence numbers for outgoing and incoming FDs
  var fds_seqno_sent = 0;
  //
  // For now, we don't try to look for incoming fd's and associate
  // them with an incoming message.
  //
  // var fds_seqno_recvd = 0;

  // Collections of messages waiting for FDs and vice-versa. These
  // are keyed by FD seqno.
  // var msg_waiting_for_fd = {};
  // var fd_waiting_for_msg = {};

  // Get the JS object representing message 'v' with fd 'fd'.
  var getMsgObj = function(v, fd) {
    return [(fd != undefined) ? ++fds_seqno_sent : 0, v];
  };

  self.send = function(v, fd) {
    var ms = getMsgObj(v, fd);
    debug('Process ' + process.pid + ' sending message: ' + sys.inspect(ms));

    s.write(JSON.stringify(ms), fd)
  };

  s.addListener('message', function(ms) {
    debug('Process ' + process.pid + ' received message: ' + ms);

    var mo = JSON.parse(ms);

    // Ignore invalid messages; this is probably worth an error, though
    if (!isValidMessage(mo)) {
      debug('Process ' + process.pid + ' received INVALID message: ' + ms);
      return;
    }

    var msg = mo[1];

    //
    // We're complete; emit. Note, we currently ignore the old logic
    // of passing around fd's as we'd have to figure out how to send
    // them using the WebSocketConnection object being used from
    // https://github.com/Worlize/WebSocket-Node.git.
    // Perhaps we'll remove the functionality completely if we
    // continue to use this webworker implementation.
    //
    self.emit('msg', msg, undefined);
  });

};

sys.inherits(MsgStream, events.EventEmitter);
exports.MsgStream = MsgStream;

// Implement the WorkerLocation interface described in
// http://www.whatwg.org/specs/web-workers/current-work/#dom-workerlocation-href
//
// XXX: None of these properties are readonly as required by the spec.
var WorkerLocation = function(url) {
    var u = urllib.parse(url);

    var portForProto = function(proto) {
        switch (proto) {
        case 'http':
            return 80;

        case 'https':
            return 443;

        case 'file':
            return undefined;

        default:
            sys.debug(
                'Unknown protocol \'' + proto + '\'; returning undefined'
            );
            return undefined;
        };
    };

    this.href = u.href;
    this.protocol = u.protocol.substring(0, u.protocol.length - 1);
    this.host = u.host;
    this.hostname = u.hostname;
    this.port = (u.port) ? u.port : portForProto(this.protocol);
    this.pathname = (u.pathname) ? path.normalize(u.pathname) : '/';
    this.search = (u.search) ? u.search : '';
    this.hash = (u.hash) ? u.hash : '';
};

exports.WorkerLocation = WorkerLocation;

// Get the error message for a given exception
//
// The first line of the stack trace seems to always be the message itself.
exports.getErrorMessage = function(e) {
    try {
        return e.message || e.stack.split('\n')[0].trim();
    } catch (e) {
        return 'WebWorkers: failed to get error message';
    }
};

// Get the filename for a given exception
exports.getErrorFilename = function(e) {
    try {
        var m = e.stack.split('\n')[1].match(STACK_FRAME_RE);
        return m[1].substring(
            0,
            m[1].lastIndexOf(':', m[1].lastIndexOf(':') - 1)
        );
    } catch (e) {
        return 'WebWorkers: failed to get error filename';
    }
};

// Get the line number for a given exception
exports.getErrorLine = function(e) {
    try {
        var m = e.stack.split('\n')[1].match(STACK_FRAME_RE);
        var parts = m[1].split(':');
        return parseInt(parts[parts.length - 2]);
    } catch (e) {
        return -1;
    }
};

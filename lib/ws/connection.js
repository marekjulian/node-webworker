
var sys = require("sys");
var events = require("events");
var Buffer = require("buffer").Buffer;
var Crypto = require("crypto");
var uuid = require("node-uuid");
var _ = require('underscore');
var WebSocketConnection = require('websocket').connection;
var wwutil = require('../webworker-util');

/*-----------------------------------------------
  Debugged
-----------------------------------------------*/
var debug;

/*-----------------------------------------------
  The Connection:
-----------------------------------------------*/
module.exports = Connection;

function Connection(server, req, socket, upgradeHead){
  wwutil.debug('Creating connection instance, for socket w/ domain - ' + socket.domain + ', socket id - ' + socket.id);
  this.debug = server.debug;
  
  if (this.debug) {
    debug = function () { sys.error('\033[90mWS: ' + Array.prototype.join.call(arguments, ", ") + "\033[39m"); };
  } else {
    debug = function () { };
  }
  
  this._req = req;
  this._server = server;
  this._upgradeHead = upgradeHead;
  // this._id = this._req.socket.remotePort;
  this._id = uuid.v4();
  //
  // Once the handshake is successful, we delegate to WebSocketConnection
  // to handle data going back and forth.
  //
  this._connection = undefined;
  
  events.EventEmitter.call(this);
  
  this.version = this.getVersion();
  
  if( !checkVersion(this)) {
    this.reject("Invalid version.");
  } else {
    wwutil.debug(this._id, this.version+" connection");
    
    // Set the initial connecting state.
    this.state(1);
    
    // Allow us to send data immediately:
    req.socket.setNoDelay(true);
    
    // Hopefully allow us to keep the socket open indefinitely:
    req.socket.setTimeout(0);
    req.socket.setKeepAlive(true, 0);
    
    var connection = this;
    
    // Setup the connection manager's state change listeners:
    this.addListener("stateChange", function(state, oldstate){
      if(state == 5){
        server.manager.detach(connection._id, function(){
          server.emit("close", connection);
          connection.emit("close");
        });
      } else if(state == 4){
        server.manager.attach(connection._id, connection);
        server.emit("connection", connection);
      }
    });
    
    // Let us see the messages when in debug mode.
    if(this.debug){
      this.addListener("message", function(msg){
        debug(connection._id, "recv: " + msg);
      });
    }
    
    // Carry out the handshaking.
    //    - Draft75: There's no upgradeHead, goto Then.
    //      Draft76: If there's an upgradeHead of the right length, goto Then.
    //      Then: carry out the handshake.
    //
    //    - Currently no browsers to my knowledge split the upgradeHead off the request,
    //      but in the case it does happen, then the state is set to waiting for 
    //      the upgradeHead. 
    //
    //      HANDLING FOR THIS EDGE CASE IS NOT IMPLEMENTED.
    //
    if((this.version == "13") || (this.version == "draft75") || (this.version == "draft76" && this._upgradeHead && this._upgradeHead.length == 8)){
      wwutil.debug('About to handshake...');
      this.handshake();
    } else {
      this.state(2);
      debug(this._id, "waiting.");
    }
  }
};

sys.inherits(Connection, events.EventEmitter);

/*-----------------------------------------------
  Various utility style functions:
-----------------------------------------------*/
var writeSocket = function(socket, data, encoding, fd) {
  if(socket.writable){
    socket.write(data, encoding, fd);
    return true;
  }
  return false;
};

function checkVersion(client){
  var server_version = client._server.options.version.toLowerCase()
    , client_version = client.version = client.version || client.getVersion();
    
  return (server_version == "auto" || server_version == client_version);
};


function pack(num) {
  var result = '';
  result += String.fromCharCode(num >> 24 & 0xFF);
  result += String.fromCharCode(num >> 16 & 0xFF);
  result += String.fromCharCode(num >> 8 & 0xFF);
  result += String.fromCharCode(num &	0xFF);
  return result;
};


/*-----------------------------------------------
  Formatters for the urls
-----------------------------------------------*/
function websocket_origin(){
  var origin = this._server.options.origin || "*";
  if(origin == "*" || typeof origin == "Array"){
    origin = this._req.headers.origin;
  }
  return origin;
};

function websocket_location(){
  var location = "",
      secure = this._req.socket.secure,
      request_host = this._req.headers.host.split(":"),
      port = request_host[1];
  
  if(secure){
    location += "wss://";
  } else {
    location += "ws://";
  }
  
  location += request_host[0]
  
  if(!secure && port != 80 || secure && port != 443){
    location += ":"+port;
  }
  
  location += this._req.url;
  
  return location;
};


/*-----------------------------------------------
  0. unknown
  1. opening
  2. waiting
  3. handshaking
  4, connected
  5. closed
-----------------------------------------------*/
Connection.prototype._state = 0;


/*-----------------------------------------------
  Connection Public API
-----------------------------------------------*/
Connection.prototype.state = function(state){
  if(state !== undefined && typeof state === "number"){
    var oldstate = this._state;
    this._state = state;
    this.emit("stateChange", this._state, oldstate);
  }
};

Connection.prototype.getVersion = function(){
  if (this._req.headers["sec-websocket-version"] && (this._req.headers["sec-websocket-version"] === "13")) {
    return "13"
  }
  else if(this._req.headers["sec-websocket-key1"] && this._req.headers["sec-websocket-key2"]){
    return "draft76";
  } else {
    return "draft75";
  }
};

//
// write: Write data. fd is ignored in this
//  implementation as we use the WebSocketConnection
//  object from:
//    https://github.com/Worlize/WebSocket-Node.git
//
Connection.prototype.write = function(data, fd){
  if(this._state == 4){
    debug(this._id, "write: "+data);

    this._connection.sendUTF(data);
    return true;
  } else {
    debug(this._id, "\033[31mCouldn't send.");
  }
  return false;
};


Connection.prototype.close = function(){
  if (this._state === 4 && this._connection) {
    this._connection.close();
  }
  this.state(5);
  debug(this._id, "closed");
};


Connection.prototype.reject = function(reason){
  debug(this._id, "rejected. Reason: "+reason);
  
  this.emit("rejected");
  this.close();
};


Connection.prototype.handshake = function(){
  var that = this;
  if(this._state < 3){
    debug(this._id, this.version+" handshake");
    
    this.state(3);
    
    doHandshake[this.version].call(this);
    if (this._state === 4) {
      //
      // Create a connection object, as we are now ready to go.
      //
      debug(this._id, 'Creating WebSocketConnection ...');
      var config = {
        httpServer: null,
        maxReceivedFrameSize: 0x10000,
        maxReceivedMessageSize: 0x100000,
        fragmentOutgoingMessages: true,
        fragmentationThreshold: 0x4000,
        keepalive: true,
        keepaliveInterval: 20000,
        dropConnectionOnKeepaliveTimeout: true,
        keepaliveGracePeriod: 10000,
        useNativeKeepalive: false,
        assembleFragments: true,
        autoAcceptConnections: false,
        disableNagleAlgorithm: true,
        closeTimeout: 5000
      };
      this._connection = new WebSocketConnection(this._req.socket, undefined, undefined, false, config);
      this._connection.on('message', function(message) {
        debug(this._id, 'Have message of type - ' + message.type);
        if (message.type === 'utf8') {
          that.emit("message", message.utf8Data);
        }
      });
      this._connection.on('close', function(){
        debug(this._id, 'Connection closed...');
        that.state(5);
      });
    }
    else {
      debug(this._id, 'state is - ' + this._state);
    }
  } else {
    debug(this._id, "Already handshaked.");
  }
};

/*-----------------------------------------------
  Do the handshake.
-----------------------------------------------*/
var doHandshake = {
  /* version 13, rfc 6455 - http://datatracker.ietf.org/doc/rfc6455. */
  13: function() {
    var clientKey = this._req.headers['sec-websocket-key'];
    var sha1 = Crypto.createHash('sha1');
    sha1.update(clientKey + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
    var acceptValue = sha1.digest('base64');
    var res = "HTTP/1.1 101 Web Socket Protocol Handshake\r\n"
            + "Upgrade: WebSocket\r\n"
            + "Connection: Upgrade\r\n"
            + "Sec-WebSocket-Accept: "+acceptValue;
  
    if(this._server.options.subprotocol && typeof this._server.options.subprotocol == "string") {
      res += "\r\nWebSocket-Protocol: "+this._server.options.subprotocol;
    }
  
    writeSocket(this._req.socket, res+"\r\n\r\n", "ascii");
    this.state(4);
  },

  /* Using draft75, work out and send the handshake. */
  draft75: function(){
    var res = "HTTP/1.1 101 Web Socket Protocol Handshake\r\n"
            + "Upgrade: WebSocket\r\n"
            + "Connection: Upgrade\r\n"
            + "Sec-WebSocket-Origin: "+websocket_origin.call(this)+"\r\n"
            + "WebSocket-Location: "+websocket_location.call(this);
  
    if(this._server.options.subprotocol && typeof this._server.options.subprotocol == "string") {
      res += "\r\nWebSocket-Protocol: "+this._server.options.subprotocol;
    }
  
    writeSocket(this._req.socket, res+"\r\n\r\n", "ascii");
    this.state(4);
  },

  /* Using draft76 (security model), work out and send the handshake. */
  draft76: function(){
    var data = "HTTP/1.1 101 WebSocket Protocol Handshake\r\n"
            + "Upgrade: WebSocket\r\n"
            + "Connection: Upgrade\r\n"
            + "Sec-WebSocket-Origin: "+websocket_origin.call(this)+"\r\n"
            + "Sec-WebSocket-Location: "+websocket_location.call(this);
  
    if(this._server.options.subprotocol && typeof this._server.options.subprotocol == "string") {
      res += "\r\nSec-WebSocket-Protocol: "+this._server.options.subprotocol;
    }

    var strkey1 = this._req.headers['sec-websocket-key1']
      , strkey2 = this._req.headers['sec-websocket-key2']
      
      , numkey1 = parseInt(strkey1.replace(/[^\d]/g, ""), 10)
      , numkey2 = parseInt(strkey2.replace(/[^\d]/g, ""), 10)

      , spaces1 = strkey1.replace(/[^\ ]/g, "").length
      , spaces2 = strkey2.replace(/[^\ ]/g, "").length;


    if (spaces1 == 0 || spaces2 == 0 || numkey1 % spaces1 != 0 || numkey2 % spaces2 != 0) {
      this.reject("WebSocket contained an invalid key -- closing connection.");
    } else {
      var hash = Crypto.createHash("md5")
        , key1 = pack(parseInt(numkey1/spaces1))
        , key2 = pack(parseInt(numkey2/spaces2));

      hash.update(key1);
      hash.update(key2);
      hash.update(this._upgradeHead.toString("binary"));

      data += "\r\n\r\n";
      data += hash.digest("binary");

      writeSocket(this._req.socket, data, "binary");
      this.state(4);
    }
  }
};

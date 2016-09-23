var EventEmitter = require('events').EventEmitter;
var uuid = require('node-uuid');
var streams = require('zetta-streams');
var ObjectStream = streams.ObjectStream;
var BinaryStream = streams.BinaryStream;
var ConsumerStream = streams.ConsumerStream;
var DeviceConfig = require('./device_config');
var util = require('util');

var Device = module.exports = function Device() {
  this.id = uuid.v4();

  this.streams = {}; // has __getter__ for consumer streams
  this._streams = {}; // has actual streams supplied to .stream and .monitor
  this._emitter = new EventEmitter();
  this._allowed = {};
  this._transitions = {};
  this._monitors = [];
  this._pubsub = null;
  this._log = null;

  var self = this;
  this.on = function(type, handler) {
    self._emitter.on(type, handler);
  }.bind(this);

  // TODO: Namespace this as something weird so there's no accidental override.
  this.call = this.call.bind(this);
  this.emit = this._emitter.emit.bind(this._emitter);


  // Allow machine.DeviceConfig
  this.DeviceConfig = Device.DeviceConfig;
};

Device.DeviceConfig = DeviceConfig;

Device.ActionError = function ActionError(statusCode, properties) {
  if (statusCode === undefined) {
    statusCode = 500;
  }

  if (typeof statusCode !== 'number') {
    throw new TypeError('statusCode must be a number.');
  }

  if (properties === undefined) {
    properties = {};
  }

  if (typeof properties !== 'object') {
    throw new TypeError('Properties must be an object.');
  }
  
  Error.captureStackTrace(this, this.constructor);
  this.name = this.constructor.name;
  this.statusCode = statusCode;
  this.properties = properties;
};
util.inherits(Device.ActionError, Error);

var ReservedKeys = ['id', 'streams', '_streams', 'type', 'state', '_state', '_allowed', '_transitions', '_monitors'];

['log', 'info', 'warn', 'error'].forEach(function(level) {
  Device.prototype[level] = function(message, data) {
    this._log.emit(level, (this.name || this.type || 'device') + '-log', message, data);
  };
});

// Default Remote Update Hook
// Filter _monitors and delete keys that are not in the input
Device.prototype._remoteUpdate = function(input, cb) {
  var self = this;
  var monitors = this._monitors;
  var inputKeys = Object.keys(input);

  var acceptableKeyFilter = function(key) {
    return monitors.indexOf(key) === -1;
  };

  inputKeys
    .filter(acceptableKeyFilter)
    .forEach(function(key) {
      self[key] = input[key];
    });

  Object.keys(this._properties())
    .filter(acceptableKeyFilter)
    .forEach(function(key) {
      if (ReservedKeys.indexOf(key) === -1 && inputKeys.indexOf(key) === -1) {
        delete self[key];
      }
    });

  this.save(cb);
};

// Default Remote Fetch Hook
Device.prototype._remoteFetch = function() {
  return this._properties();
};

Device.prototype._remoteDestroy = function(cb) {
  cb(null, true);
};

Device.prototype._generate = function(config) {
  var self = this;
  this.type = config._type;
  this.name = config._name;
  this._state = config._state;
  this._transitions = config.transitions;
  this._allowed = config.allowed;

  if (Object.keys(this._transitions).length) {
    var stateStream = self._createStream('state', ObjectStream);
    Object.defineProperty(this, 'state', {
      get: function(){
        return self._state;
      },
      set: function(newValue){
        self._state = newValue;
        stateStream.write(newValue);
      }
    });
  }

  this._monitors = [];
  var monitorOptions = config.monitorsOptions || {};
  config.monitors.forEach(function(name) {
    self._initMonitor(name, monitorOptions[name]);
    self._monitors.push(name);
  });

  Object.keys(config.streams).forEach(function(name) {
    var s = config.streams[name];
    self._initStream(name, s.handler, s.options);
  });

  // Update remote fetch handler
  if (typeof config._remoteFetch === 'function') {
    this._remoteFetch = config._remoteFetch.bind(this);
  }

  // Update remote update handler
  if (typeof config._remoteUpdate === 'function') {
    this._remoteUpdate = config._remoteUpdate.bind(this);
  }

  if (typeof config._remoteDestroy === 'function') {
    this._remoteDestroy = config._remoteDestroy.bind(this);
  }
};

Device.prototype.available = function(transition) {
  var allowed = this._allowed[this.state];

  if (!allowed) {
    return false;
  }

  if(allowed.indexOf(transition) > -1) {
    return true;
  } else {
    return false;
  }
};

Device.prototype.call = function(/* type, ...args */) {

  var args = Array.prototype.slice.call(arguments);
  var type = args[0];
  var next = args[args.length-1];
  var self = this;

  var rest = null;
  if(typeof next !== 'function') {
    next = function(err){
      if (err) {
        self._log.emit('log', 'device',
            'Error calling ' + self.type + ' transition ' + type + ' (' + err + ')');
      }
    };
    rest = args.slice(1, args.length);
  } else {
    rest = args.slice(1, args.length - 1);
  }

  var cb = function callback(err) {
    if (err) {
      next(err);
      return;
    }

    var cbArgs = Array.prototype.slice.call(arguments);
    cbArgs.unshift(type);
    self._emitter.emit.apply(self._emitter, cbArgs);

    var args = [];
    if (self._transitions[type].fields) {
      self._transitions[type].fields.forEach(function(field, idx) {
        args.push({ name: field.name, value: rest[idx] });
      });
    }

    self._sendLogStreamEvent(type, args, function(json) {
      self._log.emit('log', 'device', self.type + ' transition ' + type, json);
    });

    next.apply(next, arguments);
  };
  var handlerArgs = rest.concat([cb]);

  if(this.state == 'zetta-device-destroy') {
    return next(new Error('Machine destroyed. Cannot use transition ' + type));
  }

  if (this._transitions[type]) {
    if(this._transitions[type].handler === undefined){
      return next(new Error('Machine does not implement transition '+type));
    }
    var state = self.state;
    if (self.available(type)) {
      this._transitions[type].handler.apply(this, handlerArgs);
    } else {
      next(new Error('Machine cannot use transition ' + type + ' while in ' + state));
    }
  } else {
    next(new Error('Machine cannot use transition ' + type + ' not defined'));
  }
};


// Helper method to return normal properties on device that does not get overidden by user
// setting a remoteFetch function.
Device.prototype._properties = function() {
  var properties = {};
  var self = this;
  var reserved = ['streams'];
  Object.keys(self).forEach(function(key) {
    if (reserved.indexOf(key) === -1 && typeof self[key] !== 'function' && key[0] !== '_') {
      properties[key] = self[key];
    }
  });

  this._monitors.forEach(function(name) {
    properties[name] = self[name];
  });

  return properties;
};

// External method to return properties using default remote fetch or
// user supplied remote fetch call
Device.prototype.properties = function() {
  var properties = this._remoteFetch();

  // filter out underscored properties
  Object.keys(properties).forEach(function(key) {
    if (key[0] === '_') {
      delete properties[key];
    }
  });

  // overide id, name, type, and state
  properties.id = this.id;
  properties.type = this.type;
  properties.name = this.name;

  // State not always set
  if (this.state !== undefined) {
    properties.state = this.state;
  }

  return properties;
};

// Called from zetta api resource to handle remote update
// Provides filters that should run both on user defined update hook and default hook
Device.prototype._handleRemoteUpdate = function(properties, cb) {
  var self = this;

  Object.keys(properties).forEach(function(key) {
    // filter all methods and reserved keys and underscored
    if (typeof self[key] === 'function' || ReservedKeys.indexOf(key) !== -1 || key[0] === '_') {
      delete properties[key];
    }
  });

  // Either default update hook or user supplied
  this._remoteUpdate(properties, function(err) {
    if (err) {
      return cb(err);
    }

    self._sendLogStreamEvent('zetta-properties-update', []);
    cb();
  });
};

Device.prototype._handleRemoteDestroy = function(cb) {
  this._remoteDestroy(function(err, destroyFlag) {
    if(err) {
      return cb(err);
    }

    cb(null, destroyFlag);
  });
};

Device.prototype.save = function(cb) {
  this._registry.save(this, cb);
};

Device.prototype._initMonitor = function(queueName, options) {
  if(!options) {
    options = {};
  }

  var stream = this._createStream(queueName, ObjectStream);
  var self = this;
  var value = this[queueName]; // initialize value
  Object.defineProperty(this, queueName, {
    get: function(){
      return value;
    },
    set: function(newValue){
      value = newValue;
      stream.write(newValue);
    }
  });

  if(options.disable) {
    this.disableStream(queueName);
  }

  return this;
};

Device.prototype._initStream = function(queueName, handler, options) {
  if (!options) {
    options = {};
  }
  var Type = (options.binary) ? BinaryStream : ObjectStream;
  var stream = this._createStream(queueName, Type);

  if(options.disable) {
    this.disableStream(queueName);
  }

  handler.call(this, stream);
  return this;
};



Device.prototype.createReadStream = function(name) {
  var stream = this._streams[name];

  if (!stream) {
    throw new Error('Steam does not exist: ' + name);
  }

  var queue = this.type + '/' + this.id + '/' + name;
  return new ConsumerStream(queue, { objectMode: stream._writableState.objectMode }, this._pubsub);
};

Device.prototype._createStream = function(name, StreamType) {
  var self = this;
  var queue = this.type + '/' + this.id + '/' + name;
  var stream = new StreamType(queue, {}, this._pubsub);
  this._streams[name] = stream;

  Object.defineProperty(this.streams, name, {
    get: function(){
      return self.createReadStream(name);
    }
  });

  return stream;
};

Device.prototype.transitionsAvailable = function() {
  var self = this;
  var allowed = this._allowed[this.state];
  var ret = {};

  if (!allowed) {
    return ret;
  }

  Object.keys(this._transitions).forEach(function(name) {
    if (allowed && allowed.indexOf(name) > -1) {
      ret[name] = self._transitions[name];
    }
  });

  return ret;
};

Device.prototype._sendLogStreamEvent = function(transition, args, cb) {
  var self = this;
  var topic = self.type + '/' + self.id + '/logs';
  var json = ObjectStream.format(topic, null);
  delete json.data;
  json.transition = transition;
  json.input = args;
  json.properties = self.properties();
  json.transitions = self.transitionsAvailable();
  self._pubsub.publish(topic, json);
  if(cb) {
    cb(json);
  }
};

Device.prototype.destroy = function(cb) {
  var self = this;
  if(!cb) {
    cb = function() {};
  }
  self.emit('destroy', self, cb);
};

Device.prototype.enableStream = function(name) {
  this._streams[name].enabled = true;
};

Device.prototype.disableStream = function(name) {
  this._streams[name].enabled = false;
};

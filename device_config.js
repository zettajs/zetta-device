var DeviceConfig = module.exports = function() {
  this._name = null;
  this._type = null;
  this._state = null;
  this._remoteFetch = null;
  this._remoteUpdate = null;
  this._remoteDestroy = null;
  this.streams = {};
  this.monitors = [];
  this.monitorsOptions = {};
  this.allowed = {};
  this.transitions = {};
};

DeviceConfig.prototype.name = function(name) {
  this._name = name;
  return this;
};

DeviceConfig.prototype.type = function(type) {
  this._type = type;
  return this;
};

DeviceConfig.prototype.state = function(state) {
  this._state = state;
  return this;
};

DeviceConfig.prototype.when = function(state, options) {
  var allow = options.allow;
  if (!allow) {
    return this;
  }

  this.allowed[state] = allow;
  return this;
};

DeviceConfig.prototype.map = function(name, handler, fields) {
  this.transitions[name] = {
    handler: handler,
    fields: fields
  };
  return this;
};

DeviceConfig.prototype.monitor = function(name, options) {
  this.monitors.push(name);
  this.monitorsOptions[name] = options || {};
  return this;
};

DeviceConfig.prototype.stream = function(name, handler, options) {
  this.streams[name] = {
    handler: handler,
    options: options
  };
  return this;
};

DeviceConfig.prototype.remoteFetch = function(handler) {
  this._remoteFetch = handler;
  return this;
};

DeviceConfig.prototype.remoteUpdate = function(handler) {
  this._remoteUpdate = handler;
  return this;
};

DeviceConfig.prototype.remoteDestroy = function(handler) {
  this._remoteDestroy = handler;  
  return this;
};

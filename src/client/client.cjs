'use strict';
// Plugin lifecycle policy around InputKit's public client.
const { EventEmitter } = require('node:events');
const {
  InputClient,
  InputApiError,
  InputConnectionError,
} = require('@worklouder/input-kit');

const ENDPOINT = 'ws://127.0.0.1:19147/input';
const APPLICATION_NAME = 'Work Louder for Cursor';
const PERMISSION_REVOKED_MESSAGE = 'Input permission was revoked. Run /worklouder-setup and pair again.';

// Owns plugin lifecycle policy while InputKit owns WebSocket, JSON-RPC,
// validation, request serialization, rate limiting, and response timeouts.
class Client extends EventEmitter {
  constructor(credentials, options = {}) {
    super();
    this.credentials = credentials;
    this.timeout = options.requestTimeoutMs ?? options.timeout ?? 10000;
    this.addLayerTimeout = options.addLayerTimeoutMs ?? options.timeout ?? 120000;
    this.clientOptions = {
      applicationName: options.applicationName ?? APPLICATION_NAME,
      host: options.host ?? '127.0.0.1',
      port: options.port ?? 19147,
      requestTimeoutMs: this.timeout,
      addLayerTimeoutMs: this.addLayerTimeout,
    };
    this.createClient = options.createClient ?? ((clientOptions) => new InputClient(clientOptions));
    this.epoch = 0;
    this.enabled = true;
    this.authenticated = false;
    this.permissionRevoked = false;
    this.state = 'unpaired';
  }

  setState(state) { this.state = state; this.emit('status', state); }

  async connect(authorize = false) {
    if (this.authenticated) return;
    if (this.connecting) return this.connecting;
    this.enabled = true;
    const task = this.open(authorize).finally(() => {
      if (this.connecting === task) this.connecting = undefined;
    });
    this.connecting = task;
    return task;
  }

  async open(authorize) {
    const startingEpoch = this.epoch;
    const saved = authorize ? null : await this.credentials.get();
    if (!this.enabled || startingEpoch !== this.epoch) throw new Error('Connection cancelled');
    if (!authorize && !saved) { this.setState('unpaired'); return; }

    const epoch = ++this.epoch;
    const input = this.createClient(this.clientOptions);
    this.input = input;
    this.bind(input, epoch);
    this.setState(authorize ? 'pairing' : 'connecting');

    try {
      await input.connect();
      if (!this.current(input, epoch)) throw new Error('Connection cancelled');
      if (authorize) {
        const result = await input.requestAuthorization();
        await this.credentials.set(result);
      } else {
        await input.authenticate(saved);
      }
      if (!this.current(input, epoch)) throw new Error('Connection cancelled');
      this.pairRequired = false;
      this.permissionRevoked = false;
      this.authenticated = true;
      this.retryCount = 0;
      this.setState('connected');
      this.emit('connected');
    } catch (error) {
      if (!this.current(input, epoch)) throw error;
      let failure = error;
      this.authenticated = false;
      // Never retry an authorization prompt or a configuration write automatically.
      if (authorize || error?.code === -32001) {
        this.pairRequired = true;
        clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined;
        if (error?.code === -32001) {
          await this.credentials.delete();
          this.permissionRevoked = true;
          failure = new InputApiError(error.code, PERMISSION_REVOKED_MESSAGE);
          failure.cause = error;
        }
        this.setState('unpaired');
      } else {
        this.setState('disconnected');
        if (this.enabled) this.scheduleReconnect();
      }
      void input.close().catch(() => {});
      if (error instanceof InputConnectionError && !error.code) {
        throw Object.assign(new Error('Cannot reach Input. Open the Input app.'), { cause: error });
      }
      throw failure;
    }
  }

  bind(input, epoch) {
    const forward = (eventName) => (event) => {
      if (this.current(input, epoch) && this.authenticated) this.emit(eventName, event);
    };
    input.on('devicesUpdated', forward('devicesUpdated'));
    input.on('deviceInfoChanged', forward('deviceInfoChanged'));
    input.on('keyTriggered', forward('keyTriggered'));
    input.on('notification', (notification) => {
      if (this.current(input, epoch) && this.authenticated) this.emit('notification', notification);
    });
    input.on('disconnected', () => {
      if (!this.current(input, epoch)) return;
      this.authenticated = false;
      if (this.state !== 'unpaired') this.setState('disconnected');
      if (this.enabled && !this.pairRequired) this.scheduleReconnect();
    });
    input.on('transportError', (error) => {
      if (this.current(input, epoch)) this.emit('fault', error);
    });
    input.on('protocolError', (error) => {
      if (this.current(input, epoch)) this.emit('fault', error);
    });
  }

  current(input, epoch) {
    return this.enabled && this.input === input && this.epoch === epoch;
  }

  scheduleReconnect() {
    if (this.reconnectTimer || !this.enabled) return;
    const seconds = [1, 2, 5, 10, 30][Math.min(this.retryCount ?? 0, 4)];
    this.retryCount = (this.retryCount ?? 0) + 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.enabled) this.connect().catch((error) => this.emit('fault', error));
    }, seconds * 1000);
    this.reconnectTimer.unref?.();
  }

  ready() {
    if (!this.authenticated || !this.input?.connected) throw new Error('Pair with Input first');
    return this.input;
  }

  getDevices() { return this.ready().getDevices(); }
  getDeviceInfo(deviceId) { return this.ready().getDeviceInfo(deviceId); }
  setActiveProfileLayer(options) { return this.ready().setActiveProfileLayer(options); }
  setKeyLighting(options) { return this.ready().setKeyLighting(options); }
  addLayer(options) { return this.ready().addLayer(options); }

  // Compatibility facade for the previous internal client API. New runtime code
  // uses the typed methods above; no raw InputKit transport API is exposed.
  request(method, params = {}) {
    switch (method) {
      case 'requestAuthorization': return this.input?.requestAuthorization() ?? Promise.reject(new Error('Input is not connected'));
      case 'authenticate': return this.input?.authenticate(params).then(() => ({ authenticated: true })) ?? Promise.reject(new Error('Input is not connected'));
      case 'getDevices': return this.getDevices();
      case 'getDeviceInfo': return this.getDeviceInfo(params.deviceId);
      case 'setActiveProfileLayer': return this.setActiveProfileLayer(params);
      case 'setKeyLighting': return this.setKeyLighting(params);
      case 'addLayer': return this.addLayer(params);
      default: throw new Error(`Unsupported Input method: ${method}`);
    }
  }

  stop() {
    this.enabled = false;
    this.connecting = undefined;
    clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined;
    ++this.epoch;
    this.authenticated = false;
    const input = this.input;
    this.input = undefined;
    if (input) void input.close().catch(() => {});
    this.setState('disconnected');
  }
}

module.exports = { Client, RpcError: InputApiError, ENDPOINT, PERMISSION_REVOKED_MESSAGE };

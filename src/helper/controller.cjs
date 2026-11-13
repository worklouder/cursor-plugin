'use strict';
const crypto = require('node:crypto');
const { Client, PERMISSION_REVOKED_MESSAGE } = require('../client/client.cjs');
const { Devices } = require('../domain/devices.cjs');
const { Sessions, normalizeHook } = require('../domain/sessions.cjs');
const { Lighting } = require('../domain/lighting.cjs');
const { Gestures } = require('../domain/gestures.cjs');
const { cursorLayer } = require('../resources/layers/platform.cjs');

const DEFAULTS = { brightness: 0.8, dimAfterSeconds: 0, offAfterSeconds: 180, agentKeyMode: 'recent', pinnedChats: [] };
function agentUrl(id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error('This chat does not have a supported Cursor agent link.');
  return `cursor://anysphere.cursor-deeplink/agent?id=${encodeURIComponent(id)}`;
}
class Controller {
  constructor(store, options = {}) {
    this.store = store; this.client = options.client ?? new Client(store.credentials());
    this.platform = options.platform ?? process.platform;
    this.defaultLayer = options.defaultLayer ?? cursorLayer(this.platform);
    if (store.data.inputPermissionRevoked === true) this.client.permissionRevoked = true;
    this.autoAuthorize = options.autoAuthorize ?? true;
    this.firstSetupAuthorization = this.autoAuthorize && Object.keys(store.data).length === 0;
    this.openUrl = options.openUrl ?? (async () => { throw new Error('Opening Cursor is unavailable'); });
    this.openSetup = options.openSetup ?? (async () => {});
    this.sessions = new Sessions(); this.activity = Date.now();
    this.lastError = store.data.inputPermissionRevoked === true ? PERMISSION_REVOKED_MESSAGE : null; this.lastAction = null;
    this.devices = new Devices(this.client, (error) => { if (error) this.fault(error); this.lighting?.reset(); });
    this.lighting = new Lighting(this.client, () => {
      const id = this.deviceId(); if (!id) return null;
      const settings = this.settings(), elapsed = (Date.now() - this.activity) / 1000;
      const factor = settings.offAfterSeconds > 0 && elapsed >= settings.offAfterSeconds ? 0
        : settings.dimAfterSeconds > 0 && elapsed >= settings.dimAfterSeconds ? 0.2 : 1;
      return { deviceId: id, slots: this.slots(), selectedId: this.sessions.selectedId, brightness: settings.brightness * factor };
    }, (error) => this.fault(error));
    this.gestures = new Gestures((id, gesture) => { void this.dispatch(id, gesture).catch((error) => this.fault(error)); });
    this.client.on('fault', (error) => this.fault(error));
    this.client.on('status', () => {
      if (!this.client.authenticated) { this.devices.clear(); this.gestures.clear(); this.lighting.reset(); }
    });
    this.client.on('connected', () => { this.lighting.reset(); void this.devices.refresh().catch((error) => this.fault(error)); });
    this.client.on('devicesUpdated', ({ devices }) => {
      const previous = this.deviceId();
      const replacing = this.devices.replace(devices);
      if (this.deviceId() !== previous) this.gestures.clear();
      void replacing.then(() => { if (this.deviceId() !== previous) this.gestures.clear(); }).catch((error) => this.fault(error));
    });
    this.client.on('deviceInfoChanged', (event) => {
      const previous = this.deviceId(); this.devices.update(event);
      if (this.deviceId() !== previous) this.gestures.clear();
    });
    this.client.on('keyTriggered', (event) => {
      if (this.deviceId() && event?.deviceId === this.deviceId()) this.gestures.receive(event.identifier, event.action);
    });
  }
  fault(error) { this.lastError = String(error?.message ?? 'Device operation failed'); }
  settings() { return { ...DEFAULTS, ...this.store.data.settings }; }
  slots() { const settings = this.settings(); return this.sessions.slots(settings.agentKeyMode, settings.pinnedChats); }
  deviceId() {
    const serial = this.store.data.selectedSerial;
    const selected = serial ? this.devices.list.find((device) => this.devices.info.get(device.id)?.serialNumber === serial) : undefined;
    return (selected ?? this.devices.list[0])?.id;
  }
  async start() {
    await this.client.connect().catch((error) => this.fault(error));
    if (this.firstSetupAuthorization && !this.client.authenticated && this.client.state === 'unpaired') {
      this.firstSetupAuthorization = false;
      await this.pair().catch((error) => this.fault(error));
    }
    this.timer = setInterval(() => { void this.lighting.flush().catch((error) => this.fault(error)); }, 1000);
    this.timer.unref?.();
  }
  async pair() {
    if (this.pairing) return this.pairing;
    if (this.store.data.inputAuthorizationAttempted !== true) {
      await this.store.update((data) => { data.inputAuthorizationAttempted = true; });
    }
    this.client.stop();
    this.pairing = this.client.connect(true).finally(() => { this.pairing = null; });
    await this.pairing; this.lastError = null; return { paired: true };
  }
  receive(event) {
    const normalized = normalizeHook(event); if (!normalized) throw new Error('Invalid chat activity');
    // Cursor emits this for empty drafts that have no openable agent yet.
    if (normalized.hook_event_name === 'sessionStart') return;
    if (this.sessions.receive(normalized)) { this.activity = Date.now(); void this.lighting.flush().catch((error) => this.fault(error)); }
  }
  status(forUi = false) {
    const id = this.deviceId(), info = this.devices.info.get(id), profileIndex = info?.deviceStatus?.selectedProfileIndex;
    const canAddLayer = this.client.authenticated && !!id && Number.isSafeInteger(profileIndex) && profileIndex >= 0 && !this.layerWriting;
    return {
      input: this.client.state, deviceId: id ?? null, deviceReady: this.client.authenticated && !!id,
      permission: this.client.permissionRevoked ? 'revoked' : this.client.authenticated ? 'authorized' : 'unpaired',
      devices: this.devices.list.map((device) => ({ ...device, serialNumber: this.devices.info.get(device.id)?.serialNumber, deviceStatus: this.devices.info.get(device.id)?.deviceStatus })),
      slots: this.slots().map((slot) => slot ? { id: slot.id, title: slot.title, state: slot.state } : null),
      settings: this.settings(), defaultLayerDecision: this.store.data.defaultLayerDecision ?? null,
      canAddLayer,
      canOfferDefaultLayer: forUi && canAddLayer && !this.offer && this.store.data.defaultLayerDecision === undefined,
      lastError: this.lastError, lastAction: this.lastAction,
      controls: { agentKeys: 'native agent links', dial: 'previous/next observed agent', dialPress: 'native Enter, provided by the updated Input layer', newChat: `native ${this.platform === 'win32' ? 'Ctrl' : 'Cmd'}+N on the Fast-labeled button, provided by the updated Input layer`, modelPicker: `native ${this.platform === 'win32' ? 'Ctrl' : 'Cmd'}+/ on the Fork-labeled button with stick up/down navigation`, microphone: 'native Ctrl+M while held, provided by the updated Input layer', send: 'native Enter, provided by the updated Input layer', approve: `native ${this.platform === 'win32' ? 'Ctrl' : 'Cmd'}+Enter, provided by the updated Input layer`, decline: 'native Escape, provided by the updated Input layer', otherCommands: 'stick left/right and model parameter cycling are not connected in the Agents Window build' },
    };
  }
  async chooseDevice(id) {
    if (!Number.isSafeInteger(id) || !this.devices.list.some((device) => device.id === id)) throw new Error('Choose a ready device');
    const serial = this.devices.info.get(id)?.serialNumber;
    if (!serial) throw new Error('Input has not supplied a stable device identity yet');
    await this.store.update((data) => { data.selectedSerial = serial; });
    this.gestures.clear(); this.lighting.reset(); return {};
  }
  async claimLayerOffer(manual = false) {
    if (typeof manual !== 'boolean') throw new Error('Invalid layer request');
    if (this.claimingOffer) return null;
    this.claimingOffer = (async () => {
      const status = this.status(true);
      if (manual && !status.canAddLayer) throw new Error(this.layerWriting ? 'A layer installation is already in progress' : 'Connect a device and wait for Input to report its current profile');
      if (!manual && !status.canOfferDefaultLayer) return null;
      const deviceId = this.deviceId(), profileIndex = this.devices.info.get(deviceId).deviceStatus.selectedProfileIndex;
      const offer = { nonce: crypto.randomUUID(), deviceId, profileIndex, serial: this.devices.info.get(deviceId).serialNumber, epoch: this.client.epoch, manual };
      if (!manual) await this.store.update((data) => { data.defaultLayerDecision = 'offered'; });
      this.offer = offer; return { nonce: offer.nonce, deviceId, deviceLabel: offer.serial || `Device ${deviceId}`, profileNumber: profileIndex + 1, manual };
    })().finally(() => { this.claimingOffer = null; });
    return this.claimingOffer;
  }
  async decideLayer({ accept, nonce } = {}) {
    const offer = this.offer;
    if (typeof accept !== 'boolean' || !offer || nonce !== offer.nonce) throw new Error('This setup question is no longer active');
    if (accept && this.layerWriting) throw new Error('A layer installation is already in progress');
    this.offer = null;
    if (accept) this.layerWriting = true;
    try {
      if (!offer.manual) await this.store.update((data) => { data.defaultLayerDecision = accept ? 'accepted' : 'declined'; });
      if (!accept) return { added: false };
      if (!this.client.authenticated || offer.epoch !== this.client.epoch || offer.deviceId !== this.deviceId()
        || (offer.serial && offer.serial !== this.devices.info.get(offer.deviceId)?.serialNumber)
        || !this.devices.list.some((device) => device.id === offer.deviceId)) throw new Error('The device connection changed. No layer was sent.');
      const result = await this.client.addLayer({ deviceId: offer.deviceId, profileIndex: offer.profileIndex, definition: structuredClone(this.defaultLayer) });
      if (result?.added !== true) throw new Error('Input did not confirm the layer write. Check Input before trying again.');
      return { added: true };
    } finally { if (accept) this.layerWriting = false; }
  }
  async configure(input = {}) {
    const allowed = ['brightness', 'dimAfterSeconds', 'offAfterSeconds', 'agentKeyMode', 'pinnedChats'];
    if (Object.keys(input).some((key) => !allowed.includes(key))) throw new Error('Unknown device setting');
    const next = { ...this.settings(), ...input };
    if (!Number.isFinite(next.brightness) || next.brightness < 0 || next.brightness > 1 || ![next.dimAfterSeconds, next.offAfterSeconds].every((value) => Number.isFinite(value) && value >= 0 && value <= 3600)
      || !['recent', 'priority', 'pinned'].includes(next.agentKeyMode) || !Array.isArray(next.pinnedChats) || next.pinnedChats.length > 6 || next.pinnedChats.some((id) => typeof id !== 'string' || id.length > 256)) throw new Error('Invalid device settings');
    await this.store.update((data) => { data.settings = next; }); this.lighting.reset(); this.activity = Date.now(); return {};
  }
  async dispatch(identifier, gesture) {
    if (!this.client.authenticated || !this.deviceId()) return;
    this.activity = Date.now();
    if (identifier === 'cursor.dial.press') { if (gesture === 'tap' || gesture === 'hold') await this.openSetup(); return; }
    const match = /^cursor\.agent\.([1-6])$/.exec(identifier);
    let slot;
    if (match) { if (gesture === 'hold') return; slot = this.slots()[Number(match[1]) - 1]; }
    else if (identifier === 'cursor.dial.cw' || identifier === 'cursor.dial.ccw') {
      const slots = this.slots().filter(Boolean); if (!slots.length) return;
      const current = slots.findIndex((item) => item.id === this.sessions.selectedId);
      const step = identifier.endsWith('.cw') ? 1 : -1;
      slot = slots[((current < 0 ? (step > 0 ? -1 : 0) : current) + step + slots.length) % slots.length];
    } else {
      this.lastAction = 'This control is not connected in the Agents Window build. Use its control in Cursor or assign a normal keyboard shortcut in Input.'; return;
    }
    if (!slot?.id) { this.lastAction = 'No observed chat is assigned to this key yet.'; return; }
    await this.openUrl(agentUrl(slot.id)); this.sessions.select(slot.id); this.lastAction = `Opened ${slot.title}`;
  }
  stop() { clearInterval(this.timer); this.gestures.clear(); this.client.stop(); }
}
module.exports = { Controller, DEFAULTS, agentUrl };

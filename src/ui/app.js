'use strict';
// Browser client for the helper's authenticated loopback setup page.
const $ = (id) => document.getElementById(id);
let token = location.hash.slice(1);
if (token) { sessionStorage.setItem('worklouder-token', token); history.replaceState(null, '', '/'); }
else token = sessionStorage.getItem('worklouder-token');
let offer, currentSettings, initialized = false, busy = false, claiming = false, canAddLayer = false;
const say = (text) => { $('message').textContent = text; };
const connectionLabels = { connected: 'Connected', connecting: 'Connecting…', pairing: 'Waiting for approval…', unpaired: 'Needs pairing', disconnected: 'Disconnected' };
const chatStatusLabels = { idle: 'Ready', working: 'Working', complete: 'Completed', waiting: 'Needs attention', error: 'Error' };
async function api(route, body) {
  const response = await fetch(route, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token ?? ''}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error); return result;
}
async function action(callback) {
  if (busy) return; busy = true;
  document.querySelectorAll('button').forEach((button) => { button.disabled = true; });
  try { await callback(); await refresh(); } catch (error) { say(error.message); }
  finally { busy = false; document.querySelectorAll('button').forEach((button) => { button.disabled = false; }); $('add-layer').disabled = !canAddLayer || !!offer; }
}
function showOffer(value) {
  if (!value) return; offer = value;
  $('offer').hidden = false;
  $('offer-title').textContent = offer.manual ? 'Add another Cursor layer?' : 'Add the Cursor layer?';
  $('offer-detail').textContent = `Add the latest Cursor layer to profile ${offer.profileNumber} on ${offer.deviceLabel}? Existing layers are kept.`;
  $('offer-note').textContent = offer.manual ? 'This creates another layer with the Cursor controls. Your existing layers stay unchanged.' : 'Add the recommended Cursor controls now, or skip this step and add them later.';
  $('accept-layer').textContent = 'Add Cursor layer';
  $('decline-layer').textContent = offer.manual ? 'Cancel' : 'Not now';
  $('add-layer').disabled = true;
}
async function togglePin(id) {
  const pinnedChats = currentSettings?.pinnedChats ?? [];
  const pinned = pinnedChats.includes(id);
  if (!pinned && pinnedChats.length >= 6) throw new Error('You can pin up to six chats. Unpin one first.');
  const next = pinned ? pinnedChats.filter((chatId) => chatId !== id) : [...pinnedChats, id];
  await api('/settings', { ...currentSettings, pinnedChats: next });
  say(pinned ? 'Chat unpinned.' : 'Chat pinned.');
}
async function refresh() {
  const state = await api('/state'); currentSettings = state.settings;
  $('connection').textContent = connectionLabels[state.input] ?? state.input;
  $('connection').dataset.state = state.input;
  $('helper-version').textContent = state.helperVersion ? `v${state.helperVersion}` : '';
  $('error').hidden = !state.lastError; $('error').textContent = state.lastError || '';
  $('pair').textContent = state.input === 'connected' ? 'Pair again with Input' : 'Pair with Input';
  $('device-row').hidden = state.devices.length < 2;
  const selected = $('device').value;
  $('device').replaceChildren(...state.devices.map((device) => {
    const option = document.createElement('option'); option.value = device.id; option.textContent = device.serialNumber || `Device ${device.id}`;
    option.selected = Number(selected || state.deviceId) === device.id; return option;
  }));
  canAddLayer = state.canAddLayer; $('add-layer').disabled = busy || !canAddLayer || !!offer;
  $('decision').textContent = state.defaultLayerDecision === 'accepted' ? 'You chose to add the Cursor layer during setup. It won’t be added again automatically.'
    : state.defaultLayerDecision === 'declined' ? 'You skipped the Cursor layer during setup. You can add it here at any time.'
      : state.defaultLayerDecision === 'offered' && !offer ? 'The setup question has already been shown. Add a Cursor layer here whenever you’re ready.' : '';
  $('slots').replaceChildren(...state.slots.map((slot, i) => {
    const li = document.createElement('li'); if (!slot) li.className = 'slot-empty';
    const heading = document.createElement('div'); heading.className = 'slot-heading';
    const title = document.createElement('span'); title.textContent = `${i + 1} · ${slot?.title ?? 'Available'}`; heading.append(title);
    if (slot) {
      const pinned = state.settings.pinnedChats.includes(slot.id);
      const pin = document.createElement('button'); pin.type = 'button'; pin.className = 'slot-pin';
      pin.textContent = pinned ? 'Unpin' : 'Pin'; pin.setAttribute('aria-label', `${pinned ? 'Unpin' : 'Pin'} ${slot.title}`);
      pin.onclick = () => action(() => togglePin(slot.id)); heading.append(pin);
    }
    const status = document.createElement('small'); status.className = `slot-status status-${slot?.state ?? 'empty'}`;
    status.textContent = slot ? (chatStatusLabels[slot.state] ?? slot.state) : 'No chat assigned';
    li.append(heading, status); return li;
  }));
  if (!initialized) {
    $('mode').value = state.settings.agentKeyMode;
    $('brightness').value = state.settings.brightness; $('dim').value = state.settings.dimAfterSeconds; $('off').value = state.settings.offAfterSeconds; initialized = true;
  }
  if (state.canOfferDefaultLayer && !claiming && !offer) {
    claiming = true;
    try {
      showOffer(await api('/layer/offer', {}));
    } finally { claiming = false; }
  }
}
$('pair').onclick = () => action(async () => { say('Approve the connection request in Input.'); await api('/pair', {}); say('Input is connected.'); });
$('choose-device').onclick = () => action(async () => { await api('/choose-device', { id: Number($('device').value) }); say('Device selected.'); });
$('add-layer').onclick = () => action(async () => {
  const value = await api('/layer/offer', { manual: true });
  if (!value) throw new Error('Another layer confirmation is opening. Please try again.');
  showOffer(value); $('offer').scrollIntoView({ behavior: 'smooth', block: 'center' });
});
async function decide(accept) {
  const nonce = offer?.nonce, manual = offer?.manual; offer = null; $('offer').hidden = true;
  say(accept ? 'Adding the Cursor layer…' : manual ? 'Cancelling…' : 'Skipping for now…');
  const result = await api('/layer/decision', { accept, nonce });
  say(result.added ? 'Cursor layer added. Select it on your device to start using it.' : manual ? 'No layer was added.' : 'Skipped for now. You can add the Cursor layer later.');
}
$('accept-layer').onclick = () => action(() => decide(true)); $('decline-layer').onclick = () => action(() => decide(false));
$('settings').onsubmit = (event) => { event.preventDefault(); void action(async () => {
  await api('/settings', { ...currentSettings, brightness: Number($('brightness').value), dimAfterSeconds: Number($('dim').value), offAfterSeconds: Number($('off').value), agentKeyMode: $('mode').value }); say('Changes saved.');
}); };
refresh().catch((error) => say(error.message)); setInterval(() => { if (!busy) refresh().catch((error) => say(`${error.message}. Run /worklouder-setup in Cursor to reconnect.`)); }, 2000);

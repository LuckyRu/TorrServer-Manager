// Identity the GST layer uses to keep one viewer's pipeline apart from another's.
//
// Without it TorrServer falls back to an address-and-agent fingerprint, which is right
// often enough to be useful and wrong in two ways that matter: two tabs on one machine
// look like one client and share a pipeline, and a device that changes address looks like
// a new client and strands the old one.
//
// So the identity has two halves. The device half is persistent, which is what survives an
// address change. The consumer half lives in sessionStorage, which is per tab and survives
// a reload — that is what makes two tabs two clients. Nothing here is required: a client
// that sends nothing still plays, just on the fingerprint.

var DEVICE_KEY = 'torrent_mod_device_id';
var CONSUMER_KEY = 'torrent_mod_consumer_id';

var memoryDevice = '';
var memoryConsumer = '';

function randomId() {
    var random = '';
    try {
        if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    } catch (e) {}
    for (var i = 0; i < 4; i++) random += Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
    return random;
}

function readLampaStorage(key) {
    try {
        var value = Lampa.Storage.get(key, '');
        return typeof value === 'string' ? value : '';
    } catch (e) { return ''; }
}

function writeLampaStorage(key, value) {
    try { Lampa.Storage.set(key, value); } catch (e) {}
}

function readSessionStorage(key) {
    try { return window.sessionStorage.getItem(key) || ''; } catch (e) { return ''; }
}

function writeSessionStorage(key, value) {
    try { window.sessionStorage.setItem(key, value); } catch (e) {}
}

// The device half must outlive the application, so it goes where the rest of the plugin
// keeps its settings.
function deviceId() {
    if (memoryDevice) return memoryDevice;
    memoryDevice = readLampaStorage(DEVICE_KEY);
    if (!memoryDevice) {
        memoryDevice = randomId();
        writeLampaStorage(DEVICE_KEY, memoryDevice);
    }
    return memoryDevice;
}

// The consumer half must not outlive the tab, and must not be shared with another one.
// Where sessionStorage is unavailable the in-memory value still separates two tabs; it
// only loses its identity across a reload, which costs one stranded pipeline.
function consumerId() {
    if (memoryConsumer) return memoryConsumer;
    memoryConsumer = readSessionStorage(CONSUMER_KEY);
    if (!memoryConsumer) {
        memoryConsumer = randomId();
        writeSessionStorage(CONSUMER_KEY, memoryConsumer);
    }
    return memoryConsumer;
}

export function clientId() {
    try {
        return deviceId() + '.' + consumerId();
    } catch (e) {
        return '';
    }
}

// Exposed for tests: identity is cached for the lifetime of the page, so a test that
// swaps the storage under it has to say so.
export function resetClientId() {
    memoryDevice = '';
    memoryConsumer = '';
}

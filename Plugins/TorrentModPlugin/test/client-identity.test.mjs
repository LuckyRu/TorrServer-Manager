import { clientId, resetClientId } from '../playback/client-identity.js';
import { createRunner } from './helpers/test-runner.mjs';

const runner = createRunner();

function fakeStorage() {
  const values = new Map();
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, value),
    values
  };
}

function withEnvironment({ lampa, session }, body) {
  const previousLampa = globalThis.Lampa;
  const previousWindow = globalThis.window;

  globalThis.Lampa = lampa;
  globalThis.window = { sessionStorage: session };
  resetClientId();
  try {
    return body();
  } finally {
    globalThis.Lampa = previousLampa;
    globalThis.window = previousWindow;
    resetClientId();
  }
}

function lampaStorage(values = new Map()) {
  return {
    Storage: {
      get: (key, fallback) => (values.has(key) ? values.get(key) : fallback),
      set: (key, value) => values.set(key, value)
    },
    values
  };
}

runner.test('identity is stable for the lifetime of a page', () => {
  const lampa = lampaStorage();
  withEnvironment({ lampa, session: fakeStorage() }, () => {
    const first = clientId();
    if (!first) throw new Error('no identity produced');
    if (clientId() !== first) throw new Error('identity changed between calls');
  });
});

// A device that changes address must stay the same client, otherwise the pipeline it was
// using is stranded until the inactivity sweep reclaims it.
runner.test('a reload keeps the identity of the same tab', () => {
  const persistent = new Map();
  const session = fakeStorage();

  const before = withEnvironment({ lampa: lampaStorage(persistent), session }, clientId);
  const after = withEnvironment({ lampa: lampaStorage(persistent), session }, clientId);

  if (before !== after) throw new Error(`identity did not survive a reload: ${before} != ${after}`);
});

// Two tabs share persistent storage but not sessionStorage, which is the whole reason the
// identity has two halves: without the second one they would share a pipeline.
runner.test('two tabs on one device are two clients', () => {
  const persistent = new Map();

  const first = withEnvironment({ lampa: lampaStorage(persistent), session: fakeStorage() }, clientId);
  const second = withEnvironment({ lampa: lampaStorage(persistent), session: fakeStorage() }, clientId);

  if (first === second) throw new Error('two tabs collapsed into one client');
  if (first.split('.')[0] !== second.split('.')[0]) throw new Error('two tabs disagreed about the device');
});

runner.test('two devices are two clients', () => {
  const first = withEnvironment({ lampa: lampaStorage(), session: fakeStorage() }, clientId);
  const second = withEnvironment({ lampa: lampaStorage(), session: fakeStorage() }, clientId);

  if (first === second) throw new Error('two devices produced one identity');
});

// Identity is an optimisation, never a precondition: storage that refuses to answer must
// cost isolation quality, not playback.
runner.test('storage failures still yield a usable identity', () => {
  const throwing = {
    Storage: {
      get: () => { throw new Error('denied'); },
      set: () => { throw new Error('denied'); }
    }
  };
  const throwingSession = {
    getItem: () => { throw new Error('denied'); },
    setItem: () => { throw new Error('denied'); }
  };

  withEnvironment({ lampa: throwing, session: throwingSession }, () => {
    const identity = clientId();
    if (!identity || identity.indexOf('.') < 1) throw new Error(`unusable identity ${identity}`);
    if (clientId() !== identity) throw new Error('identity was not held in memory');
  });
});

await runner.run();

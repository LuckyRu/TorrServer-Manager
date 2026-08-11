import {
  sourceBitrateBps,
  browserBufferSeconds,
  expectedSourcePiece,
  torrentBuffer,
  smoothDownloadBps,
  assessPlaybackHealth,
  playbackHealthLabel,
  playbackHealthDotCount
} from '../playback/playback-health.js';
import { createRunner } from './helpers/test-runner.mjs';

const runner = createRunner();

runner.test('source bitrate uses file bytes and probe duration', () => {
  const bitrate = sourceBitrateBps({ FileSize: 1_000_000_000, DurationNS: 1_000_000_000_000 }, {});
  if (Math.round(bitrate) !== 8_000_000) throw new Error(`unexpected bitrate ${bitrate}`);
});

runner.test('browser buffer uses the range containing current time', () => {
  const ranges = [[0, 10], [18, 42]];
  const video = {
    currentTime: 20,
    buffered: {
      length: ranges.length,
      start: (i) => ranges[i][0],
      end: (i) => ranges[i][1]
    }
  };
  if (browserBufferSeconds(video) !== 22) throw new Error('wrong browser buffer');
});

runner.test('expected piece follows selected file and generated HLS headroom', () => {
  const cache = { PiecesLength: 100 };
  const files = [{ id: 0, length: 1000 }, { id: 1, length: 2000 }];
  const piece = expectedSourcePiece(cache, files, files[1], 25, 100, 5);
  if (piece !== 16) throw new Error(`expected piece 16, got ${piece}`);
});

runner.test('torrent buffer selects reader nearest active playback and stops at first gap', () => {
  const cache = {
    PiecesLength: 100,
    Readers: [
      { Reader: 900, End: 905 },
      { Reader: 101, End: 106 }
    ],
    Pieces: {
      101: { Completed: true, Size: 100 },
      102: { Completed: true, Size: 80 },
      103: { Completed: false, Size: 100 },
      900: { Completed: true, Size: 100 }
    }
  };
  const result = torrentBuffer(cache, 100);
  if (result.bytes !== 180 || result.completed !== 2 || result.reader.Reader !== 101) {
    throw new Error(`wrong torrent buffer ${JSON.stringify(result)}`);
  }
});

runner.test('speed smoothing reacts faster to recovery than to a single zero sample', () => {
  const down = smoothDownloadBps(10_000_000, 0, 2);
  const up = smoothDownloadBps(0, 10_000_000, 2);
  if (!(down > 7_000_000 && up > 3_000_000 && up < down)) throw new Error(`unexpected smoothing down=${down} up=${up}`);
});

runner.test('full torrent cache prevents false alarm during a temporary speed pause', () => {
  const health = assessPlaybackHealth({
    browserSeconds: 10,
    sourceSeconds: 120,
    sourceBitrateBps: 10_000_000,
    downloadBps: 0,
    readyState: 4,
    hasHeartbeat: true
  });
  if (health.state !== 'good' || health.stallSeconds !== 130) throw new Error(JSON.stringify(health));
});

runner.test('slow download and short cache predict an imminent pause', () => {
  const health = assessPlaybackHealth({
    browserSeconds: 4,
    sourceSeconds: 5,
    sourceBitrateBps: 10_000_000,
    downloadBps: 2_300_000,
    readyState: 4,
    hasHeartbeat: true
  });
  if (health.state !== 'critical' || health.kind !== 'draining') throw new Error(JSON.stringify(health));
  if (!playbackHealthLabel(health).startsWith('До паузы')) throw new Error('label does not explain the forecast');
});

runner.test('fast network does not paint an almost empty browser buffer green', () => {
  const health = assessPlaybackHealth({
    browserSeconds: 1,
    sourceSeconds: 20,
    sourceBitrateBps: 10_000_000,
    downloadBps: 20_000_000,
    readyState: 4,
    hasHeartbeat: true
  });
  if (health.state !== 'warning' || health.kind !== 'growing') throw new Error(JSON.stringify(health));
});

runner.test('dots represent forecast runway without the old off-by-one', () => {
  const base = { kind: 'draining', availableSeconds: 5 };
  const cases = [
    [5, 1],
    [10, 2],
    [20, 3],
    [40, 4],
    [60, 5]
  ];
  for (const [stallSeconds, expected] of cases) {
    const actual = playbackHealthDotCount({ ...base, stallSeconds });
    if (actual !== expected) throw new Error(`${stallSeconds}s: expected ${expected}, got ${actual}`);
  }
});

await runner.run();

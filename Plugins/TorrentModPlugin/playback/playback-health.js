    function number(value) {
        value = Number(value);
        return isFinite(value) && value >= 0 ? value : 0;
    }

    function property(object, upper, lower) {
        if (!object) return undefined;
        return object[upper] !== undefined ? object[upper] : object[lower];
    }

    export function sourceBitrateBps(probe, file) {
        var size = number(property(probe, 'FileSize', 'fileSize')) || number(file && (file.length || file.size));
        var durationNS = number(property(probe, 'DurationNS', 'durationNS'));
        if (!size || !durationNS) return 0;
        return size * 8 / (durationNS / 1000000000);
    }

    export function probeDurationSeconds(probe) {
        return number(property(probe, 'DurationNS', 'durationNS')) / 1000000000;
    }

    export function browserBufferSeconds(video) {
        if (!video || !video.buffered) return 0;
        var current = number(video.currentTime);
        var bestEnd = current;
        try {
            for (var i = 0; i < video.buffered.length; i++) {
                var start = number(video.buffered.start(i));
                var end = number(video.buffered.end(i));
                if (start <= current + 0.35 && end >= current && end > bestEnd) bestEnd = end;
            }
        } catch (e) { return 0; }
        return Math.max(0, bestEnd - current);
    }

    function fileSize(file) {
        return number(file && (file.length || file.size));
    }

    function fileOffset(files, target) {
        var offset = 0;
        var targetId = target && String(target.id);
        for (var i = 0; i < (files || []).length; i++) {
            if (String(files[i] && files[i].id) === targetId) return offset;
            offset += fileSize(files[i]);
        }
        return 0;
    }

    export function expectedSourcePiece(cache, files, file, currentSeconds, durationSeconds, bufferedSeconds) {
        var pieceLength = number(property(cache, 'PiecesLength', 'piecesLength'));
        var size = fileSize(file);
        if (!pieceLength || !size) return null;
        var duration = number(durationSeconds);
        var progress = duration ? Math.min(1, (number(currentSeconds) + number(bufferedSeconds)) / duration) : 0;
        return Math.floor((fileOffset(files, file) + size * progress) / pieceLength);
    }

    function readerField(reader, name) {
        return number(property(reader, name, name.toLowerCase()));
    }

    function pieceAt(pieces, index) {
        if (!pieces) return null;
        return pieces[index] || pieces[String(index)] || null;
    }

    export function torrentBuffer(cache, expectedPiece) {
        var readers = property(cache, 'Readers', 'readers') || [];
        var pieces = property(cache, 'Pieces', 'pieces') || {};
        var pieceLength = number(property(cache, 'PiecesLength', 'piecesLength'));
        var valid = readers.filter(function (reader) {
            return readerField(reader, 'End') > readerField(reader, 'Reader');
        });
        if (!valid.length) return { bytes: 0, completed: 0, total: 0, reader: null };

        var wanted = expectedPiece === null || expectedPiece === undefined ? null : number(expectedPiece);
        valid.sort(function (a, b) {
            if (wanted === null) return readerField(b, 'Reader') - readerField(a, 'Reader');
            return Math.abs(readerField(a, 'Reader') - wanted) - Math.abs(readerField(b, 'Reader') - wanted);
        });

        var selected = valid[0];
        var start = readerField(selected, 'Reader');
        var end = readerField(selected, 'End');
        var bytes = 0;
        var completed = 0;
        while (start < end) {
            var piece = pieceAt(pieces, start);
            if (!piece || !property(piece, 'Completed', 'completed')) break;
            bytes += number(property(piece, 'Size', 'size')) || pieceLength;
            completed++;
            start++;
        }
        return { bytes: bytes, completed: completed, total: end - readerField(selected, 'Reader'), reader: selected };
    }

    export function smoothDownloadBps(previous, sample, elapsedSeconds) {
        sample = number(sample);
        if (!(previous >= 0) || !isFinite(previous)) return sample;
        var elapsed = Math.max(0.1, number(elapsedSeconds));
        var timeConstant = sample >= previous ? 4 : 8;
        var alpha = 1 - Math.exp(-elapsed / timeConstant);
        return previous + (sample - previous) * alpha;
    }

    export function assessPlaybackHealth(input) {
        input = input || {};
        var browserSeconds = number(input.browserSeconds);
        var sourceSeconds = number(input.sourceSeconds);
        var bitrate = number(input.sourceBitrateBps);
        var speed = number(input.downloadBps);
        var ratio = bitrate ? speed / (bitrate * 1.15) : null;
        var available = browserSeconds + sourceSeconds;
        var readyState = number(input.readyState);
        var paused = !!input.paused;

        if (!bitrate || !input.hasHeartbeat) {
            return { state: 'unknown', kind: 'unknown', browserSeconds: browserSeconds, sourceSeconds: sourceSeconds, availableSeconds: available, speedRatio: ratio, stallSeconds: null };
        }
        if (paused) {
            return { state: available >= 20 ? 'good' : 'warning', kind: 'paused', browserSeconds: browserSeconds, sourceSeconds: sourceSeconds, availableSeconds: available, speedRatio: ratio, stallSeconds: null };
        }
        if (browserSeconds < 1.5 && readyState < 3) {
            return { state: ratio !== null && ratio >= 1.1 && sourceSeconds >= 8 ? 'warning' : 'critical', kind: 'buffering', browserSeconds: browserSeconds, sourceSeconds: sourceSeconds, availableSeconds: available, speedRatio: ratio, stallSeconds: 0 };
        }

        var drain = ratio === null ? 1 : Math.max(0, 1 - ratio);
        var stall = drain > 0 ? browserSeconds + sourceSeconds / drain : Infinity;
        var state;
        if (browserSeconds < 3 || (drain === 0 && available < 15)) state = 'warning';
        else if (stall < 20) state = 'critical';
        else if (stall < 60) state = 'warning';
        else state = 'good';
        return { state: state, kind: drain === 0 ? 'growing' : 'draining', browserSeconds: browserSeconds, sourceSeconds: sourceSeconds, availableSeconds: available, speedRatio: ratio, stallSeconds: stall };
    }

    function durationLabel(seconds) {
        if (!isFinite(seconds)) return '∞';
        seconds = Math.max(0, seconds);
        if (seconds >= 90) return Math.floor(seconds / 60) + ':' + String(Math.round(seconds % 60)).padStart(2, '0');
        if (seconds >= 30) seconds = Math.round(seconds / 5) * 5;
        else seconds = Math.round(seconds);
        return seconds + ' с';
    }

    function ratioLabel(ratio) {
        if (ratio === null || !isFinite(ratio)) return '';
        return ' · сеть ×' + Math.min(ratio, 9.9).toFixed(1).replace('.', ',');
    }

    export function playbackHealthLabel(health) {
        if (!health || health.kind === 'unknown') return 'Буфер: оценка…';
        if (health.kind === 'buffering') return 'Буферизация' + ratioLabel(health.speedRatio);
        if (health.kind === 'paused') return 'Запас ' + durationLabel(health.availableSeconds) + ' · пауза';
        if (health.kind === 'growing') return 'Запас ' + durationLabel(health.availableSeconds) + ' ↑' + ratioLabel(health.speedRatio);
        return 'До паузы ~' + durationLabel(health.stallSeconds) + ratioLabel(health.speedRatio);
    }

    export function playbackHealthDotCount(health) {
        if (!health || health.kind === 'unknown') return 0;
        var seconds = health.kind === 'draining' && isFinite(health.stallSeconds)
            ? health.stallSeconds
            : health.availableSeconds;
        if (seconds >= 60) return 5;
        if (seconds >= 40) return 4;
        if (seconds >= 20) return 3;
        if (seconds >= 10) return 2;
        return 1;
    }

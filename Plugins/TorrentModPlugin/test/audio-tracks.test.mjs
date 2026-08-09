import { createRunner } from './helpers/test-runner.mjs';
import { normalizeAudioTracks, preferenceFromTrack, resolvePreferredTrack } from '../playback/audio-tracks.js';

const runner = createRunner();

runner.test('GST probe: берёт только audio, сохраняет реальный Index и читает Go JSON', () => {
    const tracks = normalizeAudioTracks({
        Tracks: [
            { Type: 'video', Index: 0 },
            { Type: 'audio', Index: 2, Language: 'ru', Title: 'Кубик в Кубе', Codec: 'audio/eac3', Channels: 6 },
            { Type: 'audio', Index: 7, Language: 'en', Title: 'Original', Codec: 'audio/aac', Channels: 2 },
            { Type: 'audio', Index: 2, Language: 'ru', Title: 'duplicate' }
        ]
    });

    if (tracks.length !== 2) throw new Error('ожидал две уникальные audio-дорожки: ' + JSON.stringify(tracks));
    if (tracks[0].index !== 2 || tracks[0].label !== 'Кубик в Кубе') throw new Error('потерян настоящий индекс/label: ' + JSON.stringify(tracks[0]));
    if (tracks[0].extra.codec !== 'audio/eac3' || tracks[0].extra.channels !== 6) throw new Error('потеряны технические поля');
});

runner.test('предпочтение совпадает по нормализованной студии, а не номеру дорожки', () => {
    const previousEpisode = normalizeAudioTracks({ Tracks: [
        { Type: 'audio', Index: 4, Language: 'ru', Title: 'Студия Кубик-в-Кубе' }
    ] });
    const preference = preferenceFromTrack(previousEpisode[0]);
    const nextEpisode = normalizeAudioTracks({ Tracks: [
        { Type: 'audio', Index: 1, Language: 'ru', Title: 'Дубляж' },
        { Type: 'audio', Index: 9, Language: 'ru', Title: 'Студия: Кубик в Кубе' }
    ] });
    const selected = resolvePreferredTrack(preference, nextEpisode);

    if (!selected || selected.index !== 9) throw new Error('не найден тот же перевод в другой дорожке: ' + JSON.stringify({ preference, nextEpisode, selected }));
});

runner.test('неоднозначное совпадение не угадывается', () => {
    const preference = { language: 'ru', titleNormalized: 'дубляж' };
    const selected = resolvePreferredTrack(preference, normalizeAudioTracks({ Tracks: [
        { Type: 'audio', Index: 1, Language: 'ru', Title: 'Дубляж' },
        { Type: 'audio', Index: 2, Language: 'ru', Title: 'Дубляж' }
    ] }));
    if (selected !== null) throw new Error('resolver не должен выбирать неоднозначную дорожку');
});

await runner.run();

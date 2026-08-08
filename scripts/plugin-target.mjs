// Shared by watch-plugin.mjs and build-plugin-dev.mjs so the override path (Infrastructure/
// AppPaths.cs's BuiltInPluginDevOverrideDirectory) is computed in exactly one place.
import path from 'node:path';

export function devPluginOutfile() {
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData) {
        console.error('LOCALAPPDATA is not set — this project only targets Windows.');
        process.exit(1);
    }
    return path.join(localAppData, 'TorrServer', 'dev-plugins', 'TorrentModPlugin.js');
}

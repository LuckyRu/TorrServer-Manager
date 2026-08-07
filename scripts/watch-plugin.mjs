// Dev-only fast iteration: rebuilds Plugins/TorrentModPlugin/ on every save and writes the
// bundle straight to the dev-plugins override directory BuiltInPlugins.Read() checks first — so
// PluginHub's "Обновить локальные копии" (or its periodic refresh) picks up a fresh build without
// a dotnet build/publish/restart. Uses esbuild's JS API instead of its CLI so the override path
// (derived from %LOCALAPPDATA%, a Windows env var) doesn't depend on which shell "npm run" happens
// to invoke on this machine.
import esbuild from 'esbuild';
import path from 'node:path';

const localAppData = process.env.LOCALAPPDATA;
if (!localAppData) {
    console.error('LOCALAPPDATA is not set — this project only targets Windows.');
    process.exit(1);
}

const outfile = path.join(localAppData, 'TorrServer', 'dev-plugins', 'TorrentModPlugin.js');

const ctx = await esbuild.context({
    entryPoints: ['Plugins/TorrentModPlugin/index.js'],
    bundle: true,
    format: 'iife',
    charset: 'utf8',
    outfile
});

await ctx.watch();
console.log('Watching Plugins/TorrentModPlugin/ -> ' + outfile);

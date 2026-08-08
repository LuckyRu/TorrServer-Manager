// Dev-only fast iteration: rebuilds Plugins/TorrentModPlugin/ on every save and writes the
// bundle straight to the dev-plugins override directory BuiltInPlugins.Read() checks first — so
// PluginHub's "Обновить локальные копии" (or its periodic refresh) picks up a fresh build without
// a dotnet build/publish/restart. Uses esbuild's JS API instead of its CLI so the override path
// (derived from %LOCALAPPDATA%, a Windows env var) doesn't depend on which shell "npm run" happens
// to invoke on this machine.
import esbuild from 'esbuild';
import { devPluginOutfile } from './plugin-target.mjs';

const outfile = devPluginOutfile();

const ctx = await esbuild.context({
    entryPoints: ['Plugins/TorrentModPlugin/index.js'],
    bundle: true,
    format: 'iife',
    charset: 'utf8',
    outfile
});

await ctx.watch();
console.log('Watching Plugins/TorrentModPlugin/ -> ' + outfile);

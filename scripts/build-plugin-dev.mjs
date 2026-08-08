// One-shot counterpart to watch-plugin.mjs: builds once (does not watch) and exits, so it can be
// used as a completing VS Code task (watch-plugin.mjs's ctx.watch() never exits, which a
// preLaunchTask/build task needs). Writes to the same dev-plugins override directory
// BuiltInPlugins.Read() checks before the embedded resource.
import esbuild from 'esbuild';
import { devPluginOutfile } from './plugin-target.mjs';

const outfile = devPluginOutfile();

await esbuild.build({
    entryPoints: ['Plugins/TorrentModPlugin/index.js'],
    bundle: true,
    format: 'iife',
    charset: 'utf8',
    outfile
});

console.log('Built dev override -> ' + outfile);

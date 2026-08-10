    // ---------- styles ----------

    export function addStyles() {
        if (document.getElementById('torrent-mod-styles')) return;
        var style = document.createElement('style');
        style.id = 'torrent-mod-styles';
        style.textContent = [
            '.torrent-mod__status{opacity:.7;padding:1em 0 1em 1.5em;min-height:1.6em}',
            '.torrent-mod__list{display:flex;flex-direction:column;gap:.6em;padding:0 1.4em}',
            '.torrent-mod-row{position:relative;margin:0 -.75em;padding:.8em;background:rgba(0,0,0,.3);border-radius:.2em}',
            '.torrent-mod-row.focus{padding:.8em 1.2em;box-shadow:0 0 0 2px #fff}',
            '.torrent-mod-row__icon{position:absolute;left:0;top:-.3em;width:2.4em;height:2.4em}',
            '.torrent-mod-row__icon svg{width:2.4em;height:2.4em}',
            '.torrent-mod-row__title{padding-left:2.1em;font-size:1.1em}',
            '.torrent-mod-row__subtitle{padding-left:3.4em;font-size:.7em;margin-top:.7em}',
            '.torrent-mod-row__badge{padding-left:3.4em;font-size:.7em;margin-top:.3em}',
            '.view--torrent-mod svg{margin-right:.7em}',
            // Side picker panel (right-arrow on an episode row): slide-in overlay on the right edge.
            '.torrent-mod-picker{position:fixed;z-index:9000;top:0;right:0;bottom:0;width:min(34em,45vw);background:#141a26;border-left:1px solid rgba(255,255,255,.12);transform:translateX(100%);transition:transform .25s ease;display:flex;flex-direction:column;padding-top:1em}',
            '.torrent-mod-picker--open{transform:translateX(0)}',
            '.torrent-mod-picker__body{flex:1;overflow:hidden;padding:0 1.4em 1em}',
            '.torrent-mod-picker__empty{opacity:.7;padding:1.5em;text-align:center}',
            '.torrent-mod-picker-item{position:relative;padding:.7em;margin:.15em -.75em;border-radius:.3em;background:rgba(0,0,0,.25)}',
            '.torrent-mod-picker-item.focus{box-shadow:0 0 0 2px #fff}',
            '.torrent-mod-picker-item--selected{outline:1px solid rgba(88,214,141,.8);outline-offset:-1px}',
            '.torrent-mod-picker-item__title{font-size:1em;padding-right:4.5em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
            '.torrent-mod-picker-item__badge{font-size:.72em;opacity:.85;margin-top:.35em}',
            '.torrent-mod-picker-item__details{font-size:.72em;opacity:.6;margin-top:.2em}',
            '.torrent-mod-picker-item__mark{position:absolute;top:.5em;right:.6em;color:#58d68d;font-size:.8em}',
            '@keyframes torrent-mod-spin{to{transform:rotate(360deg)}}',
            '.torrent-mod-player-preparing__overlay{position:absolute;inset:0;z-index:200;display:flex;flex-direction:column;align-items:center;justify-content:center;box-sizing:border-box;padding:2em;background:#000;color:#fff;text-align:center;pointer-events:none}',
            '.torrent-mod-player-preparing__spinner{display:block;width:2.8em;height:2.8em;border:.25em solid rgba(255,255,255,.22);border-top-color:#fff;border-radius:50%;animation:torrent-mod-spin .8s linear infinite}',
            '.torrent-mod-player-preparing__title{max-width:80%;margin-top:1.15em;font-size:1.35em;line-height:1.3}',
            '.torrent-mod-player-preparing__hint{margin-top:.7em;font-size:.8em;opacity:.5}',
            '.torrent-mod__spinner{display:inline-block;width:.9em;height:.9em;margin-right:.6em;vertical-align:-.15em;border:.15em solid rgba(255,255,255,.25);border-top-color:currentColor;border-radius:50%;animation:torrent-mod-spin .8s linear infinite}',
            '@keyframes torrent-mod-shimmer{0%{background-position:100% 0}100%{background-position:-100% 0}}',
            '.torrent-mod-row__badge--shimmer{display:inline-block;width:6em;max-width:60%;height:.85em;border-radius:.2em;background:linear-gradient(90deg,rgba(255,255,255,.08),rgba(255,255,255,.22),rgba(255,255,255,.08));background-size:200% 100%;animation:torrent-mod-shimmer 1.4s ease-in-out infinite}',
            '.torrent-mod__trackers{display:flex;flex-wrap:wrap;padding:0 0 1em 1.5em}',
            '.torrent-mod__trackers:empty{padding:0}',
            '.torrent-mod__tracker{display:inline-flex;align-items:center;overflow:hidden;white-space:nowrap;' +
                'font-size:.68em;padding:.25em .6em;margin:0 .4em .4em 0;border-radius:1em;background:rgba(255,255,255,.08);' +
                'max-width:16em;opacity:1;' +
                'transition:opacity .25s ease,max-width .25s ease,margin-right .25s ease,padding-left .25s ease,padding-right .25s ease}',
            '.torrent-mod__tracker--ok{background:rgba(88,214,141,.18);color:#8beeb3}',
            '.torrent-mod__tracker--error{background:rgba(231,76,60,.2);color:#f1948a}',
            '.torrent-mod__tracker--pending{opacity:.55}',
            '.torrent-mod__tracker--enter,.torrent-mod__tracker--leave{opacity:0;max-width:0;margin-right:0;padding-left:0;padding-right:0}'
        ].join('');
        document.head.appendChild(style);
    }

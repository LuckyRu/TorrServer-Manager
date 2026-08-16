    // ---------- styles ----------

    export function addStyles() {
        if (document.getElementById('torrent-mod-styles')) return;
        var style = document.createElement('style');
        style.id = 'torrent-mod-styles';
        style.textContent = [
            '.torrent-mod__status{opacity:.7;padding:1em 0 1em 1.5em;min-height:1.6em}',
            '.torrent-mod__list{display:flex;flex-direction:column;gap:.6em;padding:0 1.4em}',
            // contain:layout — правка бейджа одной строки не заставляет пересчитывать внутренности
            // остальных. Без paint: иконка выходит за верх строки, а фокус рисуется box-shadow'ом,
            // и paint-containment обрезал бы и то и другое.
            '.torrent-mod-row{position:relative;contain:layout;margin:0 -.75em;padding:.8em;background:rgba(0,0,0,.3);border-radius:.2em}',
            '.torrent-mod-row.focus{padding:.8em 1.2em;box-shadow:0 0 0 2px #fff}',
            '.torrent-mod-row__icon{position:absolute;left:0;top:-.3em;width:2.4em;height:2.4em}',
            '.torrent-mod-row__icon svg{width:2.4em;height:2.4em}',
            '.torrent-mod-row__title{padding-left:2.1em;font-size:1.1em}',
            '.torrent-mod-row__subtitle{padding-left:3.4em;font-size:.7em;margin-top:.7em}',
            '.torrent-mod-row__badge{padding-left:3.4em;font-size:.7em;margin-top:.3em}',
            '.torrent-mod-row__action{display:none;position:absolute;right:.75em;top:50%;transform:translateY(-50%);font-size:1.7em;line-height:1;color:rgba(255,255,255,.45)}',
            '.torrent-mod-row__action--visible{display:block}',
            '.torrent-mod-row.focus .torrent-mod-row__action--visible{color:rgba(255,255,255,.9)}',
            '.view--torrent-mod svg{margin-right:.7em}',
            // Side picker panel (right-arrow on an episode row): slide-in overlay on the right edge.
            '.torrent-mod-picker{position:fixed;z-index:9000;top:0;right:0;bottom:0;width:min(34em,45vw);background:#141a26;border-left:1px solid rgba(255,255,255,.12);transform:translateX(100%);transition:transform .25s ease;display:flex;flex-direction:column;padding-top:1em}',
            '.torrent-mod-picker--open{transform:translateX(0)}',
            '.torrent-mod-picker__body{flex:1;overflow:hidden;padding:0 1.4em 1em}',
            '.torrent-mod-picker__empty{opacity:.7;padding:1.5em;text-align:center}',
            '.torrent-mod-picker-item{position:relative;contain:layout;padding:.7em;margin:.15em -.75em;border-radius:.3em;background:rgba(0,0,0,.25)}',
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
            '.torrent-mod-health-active .value--pieces{display:none}',
            '.torrent-mod-playback-health{display:flex;align-items:center;padding:.3em 0}',
            '.torrent-mod-playback-health span{display:block;width:.8em;height:.8em;border-radius:50%;background:rgba(255,255,255,.1)}',
            '.torrent-mod-playback-health span+span{margin-left:.5em}',
            '.torrent-mod-playback-health span.active{background:#fff}',
            '.torrent-mod-playback-health span:first-child{background:rgba(255,255,255,.35)}',
            '.torrent-mod-playback-health--good span:first-child{background:#a5d15f}',
            '.torrent-mod-playback-health--warning span:first-child{background:#dfc154}',
            '.torrent-mod-playback-health--critical span:first-child{background:#e17171}',
            '.torrent-mod__spinner{display:inline-block;width:.9em;height:.9em;margin-right:.6em;vertical-align:-.15em;border:.15em solid rgba(255,255,255,.25);border-top-color:currentColor;border-radius:50%;animation:torrent-mod-spin .8s linear infinite}',
            // Шиммер держится всё время холодного поиска (до 40 с) на всех строках сезона сразу.
            // background-position не композитится и перекрашивал бы эти строки каждый кадр —
            // блик едет transform'ом по псевдоэлементу, вне layout и paint основного дерева.
            '@keyframes torrent-mod-shimmer{to{transform:translateX(100%)}}',
            '.torrent-mod-row__badge--shimmer{position:relative;display:inline-block;width:6em;max-width:60%;height:.85em;border-radius:.2em;overflow:hidden;background:rgba(255,255,255,.08)}',
            // Длинная форма вместо inset: на Chromium телевизоров (WebOS 5/6 — 68/79) inset нет.
            '.torrent-mod-row__badge--shimmer::after{content:"";position:absolute;top:0;right:0;bottom:0;left:0;background:linear-gradient(90deg,transparent,rgba(255,255,255,.22),transparent);transform:translateX(-100%);animation:torrent-mod-shimmer 1.4s ease-in-out infinite}',
            '.torrent-mod__trackers{display:flex;flex-wrap:wrap;padding:0 0 1em 1.5em}',
            '.torrent-mod__trackers:empty{padding:0}',
            // Чипы появляются и гаснут ровно тогда, когда main thread занят разбором выдачи.
            // Прежняя анимация max-width/padding/margin пересчитывала layout всей строки чипов
            // каждый кадр по 250 мс на каждый из девяти трекеров; opacity и transform идут в
            // композиторе и не трогают layout вообще.
            '.torrent-mod__tracker{display:inline-flex;align-items:center;overflow:hidden;white-space:nowrap;' +
                'font-size:.68em;padding:.25em .6em;margin:0 .4em .4em 0;border-radius:1em;background:rgba(255,255,255,.08);' +
                'max-width:16em;opacity:1;transform:none;' +
                'transition:opacity .25s ease,transform .25s ease}',
            '.torrent-mod__tracker--ok{background:rgba(88,214,141,.18);color:#8beeb3}',
            '.torrent-mod__tracker--error{background:rgba(231,76,60,.2);color:#f1948a}',
            '.torrent-mod__tracker--pending{opacity:.55}',
            '.torrent-mod__tracker--enter,.torrent-mod__tracker--leave{opacity:0;transform:scale(.85)}'
        ].join('');
        document.head.appendChild(style);
    }

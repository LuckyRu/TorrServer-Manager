    // ---------- styles ----------

    export function addStyles() {
        if (document.getElementById('torrent-mod-styles')) return;
        var style = document.createElement('style');
        style.id = 'torrent-mod-styles';
        // .torrent-mod-row* mirrors Online Mod's real .online/.online__title/.online__quality
        // structure and computed spacing — inspected live against a real running episode list
        // (getComputedStyle, not guessed from a screenshot): unfocused row padding is a uniform
        // .8em, focus adds horizontal breathing room (.8em vertical / 1.2em horizontal) and a white
        // ring (box-shadow), it does NOT invert to a white background/dark text the way the first
        // version here did — title and the secondary info line(s) both stay pure white at opacity 1
        // throughout, confirmed via computed style on both a focused and an unfocused row; the visual
        // "dimmer" look of the secondary line in a screenshot is from its smaller font-size alone
        // (≈0.625× the title's, with margin-top equal to its own font-size — a one-line-height gap),
        // not from any opacity/color dimming. We have one more info line than Online Mod does (badge
        // + subtitle vs. their single quality line) — both share the same stepped 3.4em indent
        // (title itself sits at 2.1em) rather than inventing a third indent level for it.
        style.textContent = [
            // padding, not margin: status is the last child inside Explorer's native
            // `.explorer__files-head` (moved there so scroll.minus() below can subtract its
            // height too), which has no border/padding of its own — a bottom MARGIN here would
            // collapse straight through .explorer__files-head's box and silently add 15.2px
            // of unaccounted space between the head region and .explorer__files-body, throwing
            // off the .minus() math and breaking left/right scroll bottom alignment (confirmed
            // live: the gap matched this rule's old `1em` bottom margin to within 0.01px).
            // Padding doesn't collapse, so it stays inside the height .minus() already measures.
            '.torrent-mod__status{opacity:.7;padding:0 0 1em 1.5em;min-height:1.2em}',
            // Horizontal padding on the list + matching negative margin on each row — copied from
            // Online Mod's own real computed values (its scroll body carries a `torrent-list` class
            // with ~1.4em horizontal padding, each `.online` row counters it with ~-.75em margin) —
            // not obvious from a screenshot, only visible via getComputedStyle on the live DOM.
            '.torrent-mod__list{display:flex;flex-direction:column;gap:.6em;padding:0 1.4em}',
            '.torrent-mod-row{position:relative;margin:0 -.75em;padding:.8em;background:rgba(0,0,0,.3);border-radius:.2em}',
            '.torrent-mod-row.focus{padding:.8em 1.2em;box-shadow:0 0 0 2px #fff}',
            '.torrent-mod-row__icon{position:absolute;left:0;top:-.3em;width:2.4em;height:2.4em}',
            '.torrent-mod-row__icon svg{width:2.4em;height:2.4em}',
            '.torrent-mod-row__title{padding-left:2.1em;font-size:1.1em}',
            '.torrent-mod-row__subtitle{padding-left:3.4em;font-size:.7em;margin-top:.7em}',
            '.torrent-mod-row__badge{padding-left:3.4em;font-size:.7em;margin-top:.3em}',
            '.view--torrent-mod svg{margin-right:.7em}'
        ].join('');
        document.head.appendChild(style);
    }

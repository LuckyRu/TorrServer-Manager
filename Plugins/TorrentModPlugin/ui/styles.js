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
            // Padding doesn't collapse, so it stays inside the height .minus() already measures —
            // same reasoning now applies to the TOP padding added below: safe from collapse for the
            // identical reason, not just the bottom one. Top padding was 0 originally (the line sat
            // flush against the toolbar above it); the widget is explicitly allowed to be taller now
            // (spinner + longer escalation/retry-countdown wording, occasionally two lines) and
            // needs visual breathing room from the toolbar above it to still read as one coherent
            // block instead of a cramped afterthought — user-requested explicitly. min-height bumped
            // to comfortably fit the spinner glyph + a line of text without the box visibly
            // resizing on every spinner appear/disappear.
            '.torrent-mod__status{opacity:.7;padding:1em 0 1em 1.5em;min-height:1.6em}',
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
            // Search-progress widget: a small inline spinner for the head status line (shown only
            // while selectSearchProgress().stage === 'loading') and a shimmering skeleton bar that
            // replaces the "поиск…" text badge on episode rows — both plain CSS, no image assets or
            // animation library (this bundle stays a single classic <script>, see CLAUDE.md).
            '@keyframes torrent-mod-spin{to{transform:rotate(360deg)}}',
            '.torrent-mod__spinner{display:inline-block;width:.9em;height:.9em;margin-right:.6em;vertical-align:-.15em;border:.15em solid rgba(255,255,255,.25);border-top-color:currentColor;border-radius:50%;animation:torrent-mod-spin .8s linear infinite}',
            '@keyframes torrent-mod-shimmer{0%{background-position:100% 0}100%{background-position:-100% 0}}',
            '.torrent-mod-row__badge--shimmer{display:inline-block;width:6em;max-width:60%;height:.85em;border-radius:.2em;background:linear-gradient(90deg,rgba(255,255,255,.08),rgba(255,255,255,.22),rgba(255,255,255,.08));background-size:200% 100%;animation:torrent-mod-shimmer 1.4s ease-in-out infinite}',
            // Per-tracker status row — one chip per configured indexer, named and shown as
            // pending/ok/error (selectPoolIndexers), successful ones fading out a few seconds after
            // they report. Requested directly by the user: "будет визуально видно какой трекер
            // говнит" — this is the only place in the UI that names individual trackers rather than
            // one aggregate status line. Lives right under .torrent-mod__status inside the same
            // .explorer__files-head region, so its height is covered by the same scroll.minus()
            // subtraction (see CLAUDE.md's own writeup on why that matters for this screen).
            // `:empty{padding:0}` collapses the element's own box once renderTrackers has removed
            // every chip (all trackers reported and their success-hide window elapsed) — without
            // this, the bottom padding stuck around forever as unaccounted dead space above the
            // episode list, reported live by the user ("после исчезания всех трекеров надо место
            // вверху освободить, а то пустота там остаётся"); renderTrackers's own
            // Lampa.Layer.update() call (ui/results-screen.js) is the other half of this fix — it
            // has to actually run when the list goes empty, not just when chips are present, for
            // scroll.minus()'s cached height math to learn the region shrank at all.
            //
            // Spacing is per-chip MARGIN, not the container's `gap` — deliberately, so a chip's own
            // enter/leave transition (below) can animate margin-right down to 0 together with its
            // width, and the REST of the row visibly slides to close the space as it does. `gap`
            // does not participate in a per-item transition the same way, so it would leave a
            // fixed-size hole where a collapsing chip used to be even as the chip itself shrinks to
            // nothing — the flex "list reflow" animation requested directly by the user
            // ("сдвигания/раздвигания списка") depends on margin being the thing that's animating.
            '.torrent-mod__trackers{display:flex;flex-wrap:wrap;padding:0 0 1em 1.5em}',
            '.torrent-mod__trackers:empty{padding:0}',
            '.torrent-mod__tracker{display:inline-flex;align-items:center;overflow:hidden;white-space:nowrap;' +
                'font-size:.68em;padding:.25em .6em;margin:0 .4em .4em 0;border-radius:1em;background:rgba(255,255,255,.08);' +
                'max-width:16em;opacity:1;' +
                'transition:opacity .25s ease,max-width .25s ease,margin-right .25s ease,padding-left .25s ease,padding-right .25s ease}',
            '.torrent-mod__tracker--ok{background:rgba(88,214,141,.18);color:#8beeb3}',
            '.torrent-mod__tracker--error{background:rgba(231,76,60,.2);color:#f1948a}',
            '.torrent-mod__tracker--pending{opacity:.55}',
            // Shared enter/leave collapsed state — a chip is invisible AND zero-width/zero-margin
            // here, so the transition to/from this state is what produces both the fade and the
            // "rest of the row slides over" effect in one animation, no separate JS-driven layout
            // step needed. Declared AFTER --ok/--error/--pending above (same specificity — equal-
            // weight single-class selectors — so source order decides): a node carries BOTH its
            // status class and --enter/--leave at once, and this must win the opacity conflict
            // against --pending's own `opacity:.55`, or a pending chip's entrance would never
            // actually fade in from 0.
            '.torrent-mod__tracker--enter,.torrent-mod__tracker--leave{opacity:0;max-width:0;margin-right:0;padding-left:0;padding-right:0}'
        ].join('');
        document.head.appendChild(style);
    }

    // Result type for async domain ops, applied only where it closes a real gap; see
    // docs/system-design/torrent-mod-domain-architecture.md. error.kind is a machine-readable tag
    // (not shown to the user); error.message is the Russian user-facing string.

    export function ok(value) {
        return { ok: true, value: value };
    }

    export function err(kind, message, options) {
        options = options || {};
        return {
            ok: false,
            error: {
                kind: kind,
                message: message,
                retryable: !!options.retryable,
                cause: options.cause
            }
        };
    }

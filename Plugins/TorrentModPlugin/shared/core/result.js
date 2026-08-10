
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

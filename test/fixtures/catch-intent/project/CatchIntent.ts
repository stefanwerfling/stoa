// Regression fixture (SwipeMeister false positives): a catch that documents why
// it ignores the error, or that keeps the error for later, is not swallowed.
declare function parse(text: string): unknown;
declare function login(): Promise<string | null>;

// Negative: comment-only catch documents the deliberate ignore.
export function parseConfig(raw: string): unknown {
    let options: unknown = {};
    try {
        options = parse(raw);
    } catch {
        // ignore corrupt config
    }
    return options;
}

// Negative: the error is kept and surfaced after the retry loop.
export async function retry(): Promise<string> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const token = await login();
            if (token !== null) {
                return token;
            }
        } catch (e) {
            lastError = e;
        }
    }
    throw lastError;
}

// Negative: the error is returned to the caller.
export function tryParse(raw: string): unknown {
    try {
        return parse(raw);
    } catch (error) {
        return {error};
    }
}

// Positive: returns a default, no comment, error never read.
export function swallowed(raw: string): unknown {
    try {
        return parse(raw);
    } catch (error) {
        return null;
    }
}

// Positive: overwriting the binding is not reading it.
export function overwritten(raw: string): unknown {
    try {
        return parse(raw);
    } catch (error) {
        error = undefined;
        return null;
    }
}

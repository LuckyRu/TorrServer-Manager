// ---------- minimal test runner (async-aware) ----------
export function createRunner() {
    const tests = [];
    let passed = 0;
    let failed = 0;
    return {
        test(name, fn) { tests.push({ name, fn }); },
        async run() {
            for (const { name, fn } of tests) {
                try {
                    await fn();
                    passed++;
                    console.log('  ok  ' + name);
                } catch (e) {
                    failed++;
                    console.error('  FAIL ' + name + '\n       ' + String(e && e.message || e).split('\n').join('\n       '));
                }
            }
            console.log(`\nИтог: ${passed} passed, ${failed} failed`);
            if (failed) process.exit(1);
        }
    };
}

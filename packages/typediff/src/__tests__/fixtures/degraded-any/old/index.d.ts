// Imports from a dependency that is not installed in the analysis sandbox.
// Every export that references it therefore resolves to `any`, which means the
// diff is degraded and the tool should surface a diagnostic rather than
// silently report a clean verdict.
import type { Foo } from 'totally-missing-dependency';

export declare const a: Foo;
export declare const b: Foo;

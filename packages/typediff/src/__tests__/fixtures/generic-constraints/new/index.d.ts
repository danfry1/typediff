export declare function transform<T extends string | number>(input: T): T;
export declare class Container<T extends { id: string }> { value: T; }
export declare type Mapper<T extends Record<string, unknown>> = (input: T) => T;

export declare function transform<T extends string>(input: T): T;
export declare class Container<T extends object> { value: T; }
export declare type Mapper<T extends Record<string, unknown>, U = T> = (input: T) => U;
